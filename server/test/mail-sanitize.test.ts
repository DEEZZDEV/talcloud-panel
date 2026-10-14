import { describe, expect, it } from 'vitest';
import { buildPreview, collectAttachments, decodeMimeWords, findTextPart, leafParts } from '../src/modules/mail/mime.js';
import {
  attachmentDisposition,
  cleanContentType,
  cleanLine,
  cleanMessageId,
  parseReferences,
  sanitizeFilename,
  sanitizeMailHtml,
  sniffSafeImageType,
} from '../src/modules/mail/sanitize.js';

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'font',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'li', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strike', 'strong',
  'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);

/** Vérifie structurellement qu'un HTML assaini ne contient rien d'actif (indépendamment de la charge testée). */
function assertInert(html: string): void {
  for (const match of html.matchAll(/<\s*\/?\s*([a-zA-Z!?][^\s/>]*)/g)) {
    expect(ALLOWED_TAGS.has(match[1]!.toLowerCase()), `balise inattendue <${match[1]}> dans ${html}`).toBe(true);
  }
  for (const tag of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    for (const attr of tag[0].matchAll(/\s([^\s=>"'/]+)\s*=\s*"([^"]*)"/g)) {
      const name = attr[1]!.toLowerCase();
      const value = attr[2]!.replace(/&amp;/g, '&').toLowerCase();
      expect(name.startsWith('on'), `attribut ${name} dans ${tag[0]}`).toBe(false);
      expect(['srcdoc', 'action', 'formaction', 'background', 'srcset', 'xlink:href', 'class', 'id', 'name'].includes(name), `attribut ${name}`).toBe(false);
      if (name === 'href') expect(value).toMatch(/^(https?:\/\/|mailto:)/);
      if (name === 'src') expect(value).toMatch(/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]*$/);
      if (name === 'style') {
        expect(value).not.toMatch(/url\s*\(|expression|javascript|@import|behavior|position|var\s*\(|\\/);
      }
    }
  }
  // Aucun schéma dangereux ne subsiste dans une position interprétable (les occurrences en texte sont échappées).
  expect(html).not.toMatch(/<[^>]*(javascript|vbscript|livescript)\s*:/i);
  expect(html).not.toMatch(/<[^>]*\sdata:text/i);
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);

describe('assainissement du HTML des mails', () => {
  const payloads: [name: string, html: string][] = [
    ['script simple', '<p>ok</p><script>alert(1)</script>'],
    ['script avec src', '<script src="https://evil.test/x.js"></script>'],
    ['script casse mixte', '<ScRiPt>alert(1)</sCrIpT>'],
    ['script imbriqué', '<scr<script>ipt>alert(1)</scr</script>ipt>'],
    ['script non fermé', '<script>alert(1)'],
    ['img onerror', '<img src=x onerror=alert(1)>'],
    ['img onerror sans guillemets ni espace', '<img/src="x"/onerror=alert(1)>'],
    ['handler avec majuscules', '<div ONCLICK="alert(1)" OnMouseOver=alert(2)>x</div>'],
    ['handler avec séparateur exotique', '<div onclick\n=alert(1) on\x00load=alert(2)>x</div>'],
    ['href javascript', '<a href="javascript:alert(1)">x</a>'],
    ['href javascript casse et espaces', '<a href="  JaVaScRiPt:alert(1)">x</a>'],
    ['href javascript avec tabulation', '<a href="java\tscript:alert(1)">x</a>'],
    ['href javascript avec retour à la ligne', '<a href="java\nscript:alert(1)">x</a>'],
    ['href javascript entités décimales', '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>'],
    ['href javascript entités hexadécimales sans point-virgule', '<a href="&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A;alert(1)">x</a>'],
    ['href javascript entité nommée', '<a href="javascript&colon;alert(1)">x</a>'],
    ['href javascript entité de tabulation', '<a href="jav&#x09;ascript:alert(1)">x</a>'],
    ['href vbscript', '<a href="vbscript:msgbox(1)">x</a>'],
    ['href data html', '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>'],
    ['href relatif vers le panel', '<a href="/api/auth/logout">x</a>'],
    ['href relatif au protocole', '<a href="//evil.test/x">x</a>'],
    ['svg onload', '<svg onload=alert(1)></svg>'],
    ['svg avec script', '<svg><script>alert(1)</script></svg>'],
    ['svg animate href', '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>'],
    ['svg foreignObject', '<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>'],
    ['math', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>'],
    ['iframe', '<iframe src="https://evil.test"></iframe>'],
    ['iframe srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['base', '<base href="https://evil.test/"><a href="x">lien</a>'],
    ['form', '<form action="https://evil.test"><input name="password"><button formaction="javascript:alert(1)">ok</button></form>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
    ['link stylesheet', '<link rel="stylesheet" href="https://evil.test/x.css">'],
    ['object et embed', '<object data="https://evil.test/x.swf"></object><embed src="https://evil.test/x.swf">'],
    ['bloc style', '<style>body{background:url(https://evil.test/pixel)} @import "https://evil.test/x.css";</style><p>x</p>'],
    ['style url', '<div style="background:url(https://evil.test/pixel.gif)">x</div>'],
    ['style background-image', '<div style="background-image: url(\'https://evil.test/p\')">x</div>'],
    ['style url javascript', '<div style="background:url(javascript:alert(1))">x</div>'],
    ['style expression', '<div style="width: expression(alert(1))">x</div>'],
    ['style expression obfusquée', '<div style="width: exp/**/ression(alert(1)); color: red">x</div>'],
    ['style échappement CSS', '<div style="background:\\75 rl(https://evil.test/p)">x</div>'],
    ['style behavior', '<div style="behavior:url(x.htc)">x</div>'],
    ['style -moz-binding', '<div style="-moz-binding:url(https://evil.test/x.xml#x)">x</div>'],
    ['style position fixe (recouvrement)', '<div style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999">x</div>'],
    ['style qui ferme l’attribut', '<div style="color:red&quot; onclick=&quot;alert(1)">x</div>'],
    ['attribut background', '<table background="https://evil.test/pixel.gif"><tr><td background="javascript:alert(1)">x</td></tr></table>'],
    ['balise mal formée', '<img src="x" onerror="alert(1)"'],
    ['chevrons en trop', '<<script>alert(1)//<</script>'],
    ['commentaire conditionnel', '<!--[if gte IE 4]><script>alert(1)</script><![endif]-->'],
    ['commentaire piégé', '<!-- --!><script>alert(1)</script> -->'],
    ['CDATA', '<![CDATA[<script>alert(1)</script>]]>'],
    ['noscript mXSS', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
    ['textarea', '<textarea><script>alert(1)</script></textarea>'],
    ['title', '<title><img src=x onerror=alert(1)></title>'],
    ['xmp', '<xmp><script>alert(1)</script></xmp>'],
    ['plaintext', '<plaintext><script>alert(1)</script>'],
    ['template', '<template><script>alert(1)</script></template>'],
    ['details ontoggle', '<details open ontoggle=alert(1)>x</details>'],
    ['video et audio', '<video src="https://evil.test/v.mp4" onerror=alert(1)></video><audio src=x onerror=alert(1)></audio>'],
    ['input autofocus', '<input autofocus onfocus=alert(1)>'],
    ['marquee', '<marquee onstart=alert(1)>x</marquee>'],
    ['image data svg', '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+">'],
    ['image data html', '<img src="data:text/html,<script>alert(1)</script>">'],
    ['image javascript', '<img src="javascript:alert(1)">'],
    ['image srcset', '<img srcset="https://evil.test/a.png 1x, https://evil.test/b.png 2x">'],
    ['attributs dynsrc/lowsrc', '<img dynsrc="javascript:alert(1)" lowsrc="javascript:alert(1)">'],
    ['id et name (DOM clobbering)', '<a id="location" name="cookie" href="https://exemple.test">x</a><div id="document">y</div>'],
    ['octet nul', '<scr\x00ipt>alert(1)</scr\x00ipt><img src="java\x00script:alert(1)">'],
    ['guillemets déséquilibrés', '<a href="https://exemple.test" title="x"onmouseover="alert(1)">x</a>'],
    ['attribut avec accent grave', '<img src=`x`onerror=alert(1)>'],
  ];

  it.each(payloads)('neutralise : %s', (_name, payload) => {
    const { html } = sanitizeMailHtml(payload);
    assertInert(html);
  });

  it('ne laisse aucun texte de script ou de style dans le résultat', () => {
    const { html } = sanitizeMailHtml('<p>avant</p><script>var secret = 1;</script><style>.x{color:red}</style><p>après</p>');
    expect(html).toBe('<p>avant</p><p>après</p>');
  });

  it('échappe le texte : une balise écrite en entités reste du texte', () => {
    const { html } = sanitizeMailHtml('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('force target et rel sur les liens, même si le mail en fournit d’autres', () => {
    const { html } = sanitizeMailHtml('<a href="https://exemple.test/page?a=1&b=2" target="_top" rel="opener">lien</a>');
    expect(html).toBe('<a href="https://exemple.test/page?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">lien</a>');
  });

  it('conserve les liens mailto et retire le href des liens non absolus', () => {
    expect(sanitizeMailHtml('<a href="mailto:support@exemple.test">écrire</a>').html).toContain('href="mailto:support@exemple.test"');
    expect(sanitizeMailHtml('<a href="/dashboard">x</a>').html).toBe('<a>x</a>');
    expect(sanitizeMailHtml('<a href="ftp://exemple.test/f">x</a>').html).toBe('<a>x</a>');
  });

  it('bloque les images distantes et le signale', () => {
    const result = sanitizeMailHtml('<p>Bonjour</p><img src="https://tracker.test/pixel.gif?u=42" alt="logo" width="1" height="1">');
    expect(result.remoteContentBlocked).toBe(true);
    expect(result.html).not.toContain('tracker.test');
    expect(result.html).toContain('data-remote-blocked="1"');
    expect(result.html).toContain('alt="logo"');
    assertInert(result.html);
  });

  it.each(['http://t.test/p.png', '//t.test/p.png', ' https://t.test/p.png', 'HTTPS://t.test/p.png', 'ht\ntps://t.test/p.png'])('bloque la source distante %j', (src) => {
    const result = sanitizeMailHtml(`<img src="${src}">`);
    expect(result.remoteContentBlocked).toBe(true);
    expect(result.html).not.toContain('t.test');
  });

  it('signale aussi les arrière-plans distants retirés', () => {
    expect(sanitizeMailHtml('<td background="https://t.test/bg.png">x</td>').remoteContentBlocked).toBe(true);
    expect(sanitizeMailHtml('<div style="background-image:url(https://t.test/bg.png)">x</div>').remoteContentBlocked).toBe(true);
  });

  it('ne signale rien pour un mail sans contenu distant', () => {
    const result = sanitizeMailHtml('<p style="color:#333">Bonjour <b>à tous</b></p>');
    expect(result.remoteContentBlocked).toBe(false);
    expect(result.html).toBe('<p style="color:#333">Bonjour <b>à tous</b></p>');
  });

  it('convertit une image cid: jointe en data: d’un type image vérifié', () => {
    const result = sanitizeMailHtml('<img src="cid:logo@exemple" alt="Logo">', new Map([['logo@exemple', PNG]]));
    expect(result.html).toBe(`<img alt="Logo" src="data:image/png;base64,${PNG.toString('base64')}" />`);
    expect(result.remoteContentBlocked).toBe(false);
  });

  it('refuse une pièce cid: qui n’est pas une image sûre (SVG, HTML) quel que soit son type déclaré', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    const htmlDoc = Buffer.from('<html><script>alert(1)</script></html>');
    const result = sanitizeMailHtml('<img src="cid:a"><img src="cid:b"><img src="cid:absent">', new Map([['a', svg], ['b', htmlDoc]]));
    expect(result.html).not.toContain('src=');
    assertInert(result.html);
  });

  it('refuse une image cid: trop volumineuse et borne le total intégré', () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    expect(sanitizeMailHtml('<img src="cid:big">', new Map([['big', big]])).html).not.toContain('src=');

    const medium = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
    const many = sanitizeMailHtml('<img src="cid:m">'.repeat(10), new Map([['m', medium]]));
    const embedded = many.html.match(/src="data:/g)?.length ?? 0;
    expect(embedded).toBeGreaterThan(0);
    expect(embedded).toBeLessThanOrEqual(4);
    expect(many.html.length).toBeLessThan(7 * 1024 * 1024);
  });

  it('retire une source data: fournie par le mail, même de type image', () => {
    const result = sanitizeMailHtml(`<img src="data:image/png;base64,${PNG.toString('base64')}">`);
    expect(result.html).not.toContain('src=');
  });

  it('restreint le style en ligne à des propriétés et valeurs inoffensives', () => {
    const { html } = sanitizeMailHtml(
      '<p style="color: red; font-size: 14px; position: absolute; background: url(https://t.test/x); margin: 0 auto; width: calc(100% - 1px); text-align: center">x</p>',
    );
    expect(html).toContain('color:red');
    expect(html).toContain('font-size:14px');
    expect(html).toContain('margin:0 auto');
    expect(html).toContain('text-align:center');
    expect(html).not.toMatch(/position|url|calc|t\.test/);
  });

  it('conserve la structure utile d’un mail (tableaux, listes, citations)', () => {
    const source = '<table width="600" cellpadding="0"><tbody><tr><td colspan="2" valign="top">A</td></tr></tbody></table><ul><li>un</li></ul><blockquote>cité</blockquote>';
    expect(sanitizeMailHtml(source).html).toBe(source);
  });

  it('supporte une imbrication très profonde sans erreur', () => {
    const { html } = sanitizeMailHtml(`${'<div>'.repeat(5000)}x${'</div>'.repeat(5000)}`);
    assertInert(html);
  });
});

describe('détection du type d’image', () => {
  it('reconnaît PNG, JPEG, GIF, WebP et rien d’autre', () => {
    expect(sniffSafeImageType(PNG)).toBe('image/png');
    expect(sniffSafeImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffSafeImageType(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(sniffSafeImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffSafeImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffSafeImageType(Buffer.from('<!doctype html>'))).toBeNull();
    expect(sniffSafeImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('assainissement des noms de fichiers', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\Windows\\System32\\config\\SAM', 'SAM'],
    ['C:\\Users\\admin\\facture.pdf', 'facture.pdf'],
    ['/abs/olu/rapport.pdf', 'rapport.pdf'],
    ['.htaccess', 'htaccess'],
    ['...', 'piece-jointe'],
    ['', 'piece-jointe'],
    ['   ', 'piece-jointe'],
    ['fichier.pdf.', 'fichier.pdf'],
    ['fichier.pdf   ', 'fichier.pdf'],
    ['a\r\nContent-Type: text/html\r\n\r\n<script>.pdf', 'html_script_.pdf'],
    ['nom\0cache.exe', 'nomcache.exe'],
    ['fac"ture.pdf', 'fac_ture.pdf'],
    ['a<b>c:d|e?f*g.txt', 'a_b_c_d_e_f_g.txt'],
    ['rapport;filename=evil.exe', 'rapport_filename=evil.exe'],
    ['100%41.txt', '100_41.txt'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['COM1.log', '_COM1.log'],
    ['Reçu été 2026.pdf', 'Reçu été 2026.pdf'],
    ['文档.pdf', '文档.pdf'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it('retire les caractères de direction d’écriture qui masquent l’extension réelle', () => {
    // « facture\u202efdp.exe » s'affiche « factureexe.pdf » avec U+202E.
    expect(sanitizeFilename('facture\u202efdp.exe')).toBe('facturefdp.exe');
    expect(sanitizeFilename('a\u200bb\u2066c\ufeff.txt')).toBe('abc.txt');
  });

  it('borne la longueur en conservant l’extension', () => {
    const name = sanitizeFilename(`${'a'.repeat(400)}.pdf`);
    expect(name.length).toBe(150);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('accepte une valeur non textuelle', () => {
    expect(sanitizeFilename(undefined)).toBe('piece-jointe');
    expect(sanitizeFilename({ toString: () => '../x' })).toBe('piece-jointe');
    expect(sanitizeFilename(null, 'repli.bin')).toBe('repli.bin');
  });

  it('ne produit jamais de séparateur, de contrôle ni de nom vide', () => {
    const hostile = ['../', '..\\', '\u0000', '\r\n', '/', '\\', '..', '.', ' . ', 'a/../../b', '\ud800', 'x\udfffy', '\u202e', '%2e%2e%2f', '"; filename="x'];
    for (const input of hostile) {
      const name = sanitizeFilename(input);
      expect(name.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-control-regex
      expect(name).not.toMatch(/[/\\\x00-\x1f\x7f"<>:|?*;%]/);
      expect(name.startsWith('.')).toBe(false);
      expect(() => encodeURIComponent(name)).not.toThrow();
    }
  });
});

describe('en-tête Content-Disposition', () => {
  it('force le téléchargement avec un repli ASCII et un nom RFC 5987', () => {
    expect(attachmentDisposition('Reçu n°1.pdf')).toBe(`attachment; filename="Re_u n_1.pdf"; filename*=UTF-8''Re%C3%A7u%20n%C2%B01.pdf`);
    expect(attachmentDisposition('simple.txt')).toBe(`attachment; filename="simple.txt"; filename*=UTF-8''simple.txt`);
  });

  it('ne peut pas être détourné par le nom de fichier (guillemets, retours à la ligne, paramètres)', () => {
    const hostile = ['a".html', 'a\r\nSet-Cookie: x=1', "x'; DROP.txt", 'inline; filename=evil.html', 'é"\\\r\n.pdf', "it's (1)*.txt"];
    for (const input of hostile) {
      const header = attachmentDisposition(input);
      expect(header.startsWith('attachment; filename="')).toBe(true);
      // eslint-disable-next-line no-control-regex
      expect(header).not.toMatch(/[\x00-\x1f\x7f]/);
      const match = /^attachment; filename="([^"\\]*)"; filename\*=UTF-8''([A-Za-z0-9._~!$&+%-]*)$/.exec(header);
      expect(match, header).not.toBeNull();
    }
  });
});

describe('valeurs d’en-têtes issues d’un mail', () => {
  it('valide les Message-ID', () => {
    expect(cleanMessageId('<abc.123@exemple.test>')).toBe('<abc.123@exemple.test>');
    expect(cleanMessageId('  <abc@x>  ')).toBe('<abc@x>');
    expect(cleanMessageId('<abc@x>\r\nBcc: victime@exemple.test')).toBeNull();
    expect(cleanMessageId('<a b@x>')).toBeNull();
    expect(cleanMessageId('abc@x')).toBeNull();
    expect(cleanMessageId('<a@x> <b@x>')).toBeNull();
    expect(cleanMessageId(`<${'a'.repeat(300)}@x>`)).toBeNull();
    expect(cleanMessageId(undefined)).toBeNull();
  });

  it('extrait des References filtrées et bornées', () => {
    expect(parseReferences('<a@x> <b@x>\r\n <c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(parseReferences('n’importe quoi\r\nBcc: x@y')).toEqual([]);
    const many = Array.from({ length: 50 }, (_v, i) => `<m${i}@x>`).join(' ');
    expect(parseReferences(many)).toHaveLength(20);
    expect(parseReferences(many).at(-1)).toBe('<m49@x>');
  });

  it('nettoie les lignes et les types MIME', () => {
    expect(cleanLine('Objet\r\nBcc: x@y\u202e', 100)).toBe('Objet Bcc: x@y');
    expect(cleanLine(42, 10)).toBe('');
    expect(cleanLine('a'.repeat(50), 10)).toHaveLength(10);
    expect(cleanContentType('Application/PDF; name="x"')).toBe('application/pdf');
    expect(cleanContentType('text/html\r\nX: y')).toBe('application/octet-stream');
    expect(cleanContentType('n’importe quoi')).toBe('application/octet-stream');
    expect(cleanContentType(undefined)).toBe('application/octet-stream');
  });
});

describe('structure MIME', () => {
  const structure = {
    type: 'multipart/mixed',
    childNodes: [
      {
        part: '1',
        type: 'multipart/related',
        childNodes: [
          {
            part: '1.1',
            type: 'multipart/alternative',
            childNodes: [
              { part: '1.1.1', type: 'text/plain', encoding: 'quoted-printable', size: 120, parameters: { charset: 'iso-8859-1' } },
              { part: '1.1.2', type: 'text/html', encoding: 'base64', size: 4000, parameters: { charset: 'utf-8' } },
            ],
          },
          { part: '1.2', type: 'image/png', id: '<logo@x>', encoding: 'base64', size: 4000, disposition: 'inline' },
        ],
      },
      { part: '2', type: 'application/pdf', encoding: 'base64', size: 4000, disposition: 'attachment', dispositionParameters: { filename: '=?UTF-8?B?UmXDp3UucGRm?=' } },
      { part: '3', type: 'text/html', encoding: '7bit', size: 300, disposition: 'attachment', dispositionParameters: { filename: '../../evil.html' } },
      { part: '4', type: 'message/rfc822', encoding: '7bit', size: 900, childNodes: [{ part: '4', type: 'text/plain' }] },
    ],
  };

  it('liste les pièces jointes sans les corps ni les images intégrées', () => {
    expect(collectAttachments(structure)).toEqual([
      { id: '2', filename: 'Reçu.pdf', contentType: 'application/pdf', size: 3000 },
      { id: '3', filename: 'evil.html', contentType: 'text/html', size: 300 },
      { id: '4', filename: 'message.eml', contentType: 'message/rfc822', size: 900 },
    ]);
    expect(leafParts(structure).map((leaf) => leaf.part)).toEqual(['1.1.1', '1.1.2', '1.2', '2', '3', '4']);
  });

  it('choisit la partie texte et gère un message à partie unique', () => {
    expect(findTextPart(structure)).toEqual({ part: '1.1.1', kind: 'plain', encoding: 'quoted-printable', charset: 'iso-8859-1' });
    expect(findTextPart({ type: 'text/html', encoding: 'base64' })).toEqual({ part: '1', kind: 'html', encoding: 'base64', charset: undefined });
    expect(collectAttachments({ type: 'text/plain' })).toEqual([]);
    expect(collectAttachments(undefined)).toEqual([]);
  });

  it('borne une structure démesurée', () => {
    let deep: { type: string; part?: string; childNodes?: unknown[] } = { type: 'application/pdf', part: '1' };
    for (let i = 0; i < 200; i += 1) deep = { type: 'multipart/mixed', childNodes: [deep] };
    expect(collectAttachments(deep as never)).toEqual([]);
    const wide = { type: 'multipart/mixed', childNodes: Array.from({ length: 5000 }, (_v, i) => ({ type: 'application/pdf', part: String(i + 1) })) };
    expect(collectAttachments(wide).length).toBe(200);
  });

  it('décode les noms encodés (RFC 2047)', () => {
    expect(decodeMimeWords('=?UTF-8?Q?Re=C3=A7u_2026.pdf?=')).toBe('Reçu 2026.pdf');
    expect(decodeMimeWords('=?iso-8859-1?Q?fa=E7ade?= =?utf-8?B?LnBkZg==?=')).toBe('façade.pdf');
    expect(decodeMimeWords('=?charset-inconnu?B?YWJj?=')).toBe('abc');
    expect(decodeMimeWords('simple.txt')).toBe('simple.txt');
  });

  it('construit un aperçu texte à partir d’un fragment encodé', () => {
    expect(buildPreview(Buffer.from('Bonjour,=0D=0Avoici la fa=E7ade =\r\nrefaite', 'latin1'), { part: '1', kind: 'plain', encoding: 'quoted-printable', charset: 'iso-8859-1' })).toBe(
      'Bonjour, voici la façade refaite',
    );
    const b64 = Buffer.from('Un message en base64 assez long pour être coupé').toString('base64');
    expect(buildPreview(Buffer.from(b64.slice(0, 30)), { part: '1', kind: 'plain', encoding: 'base64', charset: 'utf-8' })).toBe('Un message en base64');
    const html = '<html><head><style>p{color:red}</style></head><body><p>Bonjour &amp; bienvenue <b>ici</b></p><script>alert(1)</script><a href="https://exem';
    expect(buildPreview(Buffer.from(html), { part: '1', kind: 'html', encoding: '7bit', charset: 'utf-8' })).toBe('Bonjour & bienvenue ici');
    expect(buildPreview(Buffer.from('x'.repeat(1000)), { part: '1', kind: 'plain', encoding: '7bit', charset: undefined }).length).toBe(180);
  });
});
