import sanitizeHtml from 'sanitize-html';
import { LIMITS } from './validation.js';

/**
 * Assainissement du contenu hostile des mails : HTML, noms de fichiers, valeurs d'en-têtes.
 * Fonctions pures, testées unitairement (test/mail-sanitize.test.ts).
 */

// ───────────────────────────── HTML ─────────────────────────────

export interface SanitizedHtml {
  html: string;
  /** Des contenus distants (images, arrière-plans) ont été retirés. */
  remoteContentBlocked: boolean;
}

/** Balises conservées. Tout le reste est retiré : script, style, iframe, object, embed, form, meta, link, base, svg, math… */
const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em',
  'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'li', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strike',
  'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
];

/** Balises dont le CONTENU est supprimé avec la balise (sinon leur texte serait réinjecté dans la page). */
const DROPPED_WITH_CONTENT = [
  'script', 'style', 'title', 'head', 'textarea', 'option', 'select', 'noscript', 'noembed', 'noframes', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'svg', 'math', 'template', 'xmp', 'plaintext', 'listing', 'audio', 'video', 'canvas', 'button', 'datalist',
  'map', 'area',
];

const GLOBAL_ATTRIBUTES = ['style', 'title', 'dir', 'lang', 'align'];

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*){2,3}\)|[a-z]{3,20})$/i;
const LENGTH = /^(auto|0|-?\d{1,4}(\.\d{1,3})?(px|em|rem|pt|%))$/i;
const LENGTHS = /^(auto|0|-?\d{1,4}(\.\d{1,3})?(px|em|rem|pt|%)?)(\s+(auto|0|-?\d{1,4}(\.\d{1,3})?(px|em|rem|pt|%)?)){0,3}$/i;
const BORDER = /^[a-z0-9#.% -]{1,60}$/i;

const BOX_SIDES = ['', '-top', '-right', '-bottom', '-left'];
const sided = (property: string, pattern: RegExp): Record<string, RegExp[]> =>
  Object.fromEntries(BOX_SIDES.map((side) => [`${property}${side}`, [pattern]]));

/**
 * Styles en ligne : liste blanche de propriétés de présentation avec valeurs strictement filtrées.
 * Aucune valeur ne peut contenir url(), expression(), var(), @import, ni de positionnement.
 */
const ALLOWED_STYLES: Record<string, RegExp[]> = {
  color: [COLOR],
  'background-color': [COLOR],
  background: [COLOR],
  'font-size': [/^(\d{1,3}(\.\d{1,2})?(px|em|rem|pt|%)|x?x?-?(small|large)|medium|smaller|larger)$/i],
  'font-weight': [/^(normal|bold|bolder|lighter|[1-9]00)$/i],
  'font-style': [/^(normal|italic|oblique)$/i],
  'font-family': [/^[a-z0-9 ,'"-]{1,120}$/i],
  'text-align': [/^(left|right|center|justify)$/i],
  'text-decoration': [/^(none|underline|line-through)$/i],
  'vertical-align': [/^(top|middle|bottom|baseline)$/i],
  'line-height': [/^(normal|\d{1,3}(\.\d{1,2})?(px|em|rem|pt|%)?)$/i],
  'white-space': [/^(normal|nowrap|pre|pre-wrap|pre-line)$/i],
  'border-collapse': [/^(collapse|separate)$/i],
  width: [LENGTH],
  height: [LENGTH],
  'max-width': [LENGTH],
  ...sided('padding', LENGTHS),
  ...sided('margin', LENGTHS),
  ...sided('border', BORDER),
};

const SAFE_INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** Type d'image déduit des octets (le type déclaré par l'expéditeur n'est jamais cru). null = pas une image sûre. */
export function sniffSafeImageType(content: Buffer): (typeof SAFE_INLINE_IMAGE_TYPES)[number] | null {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg';
  if (content.length >= 6 && ['GIF87a', 'GIF89a'].includes(content.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (content.length >= 12 && content.subarray(0, 4).toString('latin1') === 'RIFF' && content.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Retire espaces, caractères de contrôle et caractères invisibles d'une URL (« java\tscript: »). */
// eslint-disable-next-line no-control-regex
const compactUrl = (value: string): string => value.replace(/[\x00-\x20\x7f-\x9f\u200b-\u200f\u2028-\u202f\u2060\ufeff]/g, '');

const normalizeCid = (value: string): string => value.trim().replace(/^<|>$/g, '');

const DIMENSION = /^\d{1,4}%?$/;

/**
 * Assainit le HTML d'un mail en liste blanche stricte. Le résultat est sûr même affiché hors iframe :
 *  - aucune balise active (script, style, iframe, object, embed, form, meta, link, base, svg…), aucun attribut `on*` ;
 *  - liens : uniquement http(s) et mailto absolus, forcés en target="_blank" rel="noopener noreferrer nofollow" ;
 *  - images : seules les images « cid: » jointes au message sont affichées, converties en data: d'un type image
 *    vérifié sur les octets et de taille bornée ; toute autre source (distante, data:, relative) est retirée ;
 *  - style en ligne restreint à une liste de propriétés/valeurs inoffensives (jamais d'url()).
 *
 * @param inlineImages contenus des pièces « cid: » du message, indexés par Content-ID (sans chevrons).
 */
export function sanitizeMailHtml(input: string, inlineImages: ReadonlyMap<string, Buffer> = new Map()): SanitizedHtml {
  let remoteContentBlocked = false;
  let inlineBudget: number = LIMITS.inlineImagesTotalBytes;
  const dataUris = new Map<string, string | null>();

  const resolveCid = (rawCid: string): string | null => {
    let cid = normalizeCid(rawCid);
    try {
      cid = normalizeCid(decodeURIComponent(cid));
    } catch {
      // Séquence %xx invalide : l'identifiant est utilisé tel quel.
    }
    let uri = dataUris.get(cid);
    if (uri === undefined) {
      const content = inlineImages.get(cid) ?? inlineImages.get(cid.toLowerCase());
      const type = content && content.length <= LIMITS.inlineImageBytes ? sniffSafeImageType(content) : null;
      uri = content && type ? `data:${type};base64,${content.toString('base64')}` : null;
      dataUris.set(cid, uri);
    }
    if (uri === null || uri.length > inlineBudget) return null;
    inlineBudget -= uri.length;
    return uri;
  };

  const isRemote = (url: string): boolean => /^(https?:|ftp:)?\/\//i.test(url) || /^\\\\/.test(url);

  const html = sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    nonTextTags: DROPPED_WITH_CONTENT,
    disallowedTagsMode: 'discard',
    allowedAttributes: {
      '*': GLOBAL_ATTRIBUTES,
      a: ['href', 'target', 'rel', ...GLOBAL_ATTRIBUTES],
      img: ['src', 'alt', 'width', 'height', 'data-remote-blocked', ...GLOBAL_ATTRIBUTES],
      font: ['color', 'size', 'face', ...GLOBAL_ATTRIBUTES],
      table: ['width', 'border', 'cellpadding', 'cellspacing', 'bgcolor', ...GLOBAL_ATTRIBUTES],
      td: ['width', 'height', 'colspan', 'rowspan', 'valign', 'bgcolor', ...GLOBAL_ATTRIBUTES],
      th: ['width', 'height', 'colspan', 'rowspan', 'valign', 'bgcolor', ...GLOBAL_ATTRIBUTES],
      tr: ['valign', 'bgcolor', ...GLOBAL_ATTRIBUTES],
      col: ['span', 'width', ...GLOBAL_ATTRIBUTES],
      colgroup: ['span', 'width', ...GLOBAL_ATTRIBUTES],
      ol: ['start', 'type', ...GLOBAL_ATTRIBUTES],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    // Les seules sources d'image qui subsistent sont les data: produites ci-dessous à partir des pièces « cid: ».
    allowedSchemesByTag: { img: ['data'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    allowedStyles: { '*': ALLOWED_STYLES },
    parseStyleAttributes: true,
    allowedClasses: {},
    allowedIframeHostnames: [],
    allowedScriptHostnames: [],
    allowVulnerableTags: false,
    enforceHtmlBoundary: false,
    nestingLimit: 100,
    transformTags: {
      a: (_tagName, attribs) => {
        const out: Record<string, string> = {};
        for (const name of GLOBAL_ATTRIBUTES) if (attribs[name] !== undefined) out[name] = attribs[name];
        const href = compactUrl(attribs.href ?? '');
        // Lien absolu uniquement : un lien relatif pointerait vers le panel lui-même.
        if (/^(https?:\/\/|mailto:)[^\s]/i.test(href)) {
          out.href = href;
          out.target = '_blank';
          out.rel = 'noopener noreferrer nofollow';
        }
        return { tagName: 'a', attribs: out };
      },
      img: (_tagName, attribs) => {
        const out: Record<string, string> = {};
        if (attribs.alt !== undefined) out.alt = attribs.alt.slice(0, 200);
        if (attribs.title !== undefined) out.title = attribs.title.slice(0, 200);
        if (attribs.width !== undefined && DIMENSION.test(attribs.width)) out.width = attribs.width;
        if (attribs.height !== undefined && DIMENSION.test(attribs.height)) out.height = attribs.height;
        if (attribs.style !== undefined) out.style = attribs.style;

        const src = compactUrl(attribs.src ?? '');
        if (/^cid:/i.test(src)) {
          const uri = resolveCid(src.slice(4));
          if (uri) out.src = uri;
        } else if (isRemote(src)) {
          remoteContentBlocked = true;
          out['data-remote-blocked'] = '1';
        }
        if (attribs.srcset !== undefined && attribs.srcset.trim() !== '') {
          remoteContentBlocked = true;
          out['data-remote-blocked'] = '1';
        }
        return { tagName: 'img', attribs: out };
      },
      '*': (tagName, attribs) => {
        // Arrière-plans distants (attribut « background » ou url() dans le style) : retirés par la liste blanche,
        // signalés ici pour que l'interface puisse l'indiquer.
        if ((attribs.background !== undefined && isRemote(compactUrl(attribs.background))) || /url\s*\(/i.test(attribs.style ?? '')) {
          remoteContentBlocked = true;
        }
        return { tagName, attribs };
      },
    },
  });

  return { html, remoteContentBlocked };
}

// ───────────────────────────── Texte et en-têtes ─────────────────────────────

/** Texte d'une ligne issu d'un mail (objet, nom d'expéditeur) : caractères de contrôle retirés, longueur bornée. */
export function cleanLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

/** Texte multi-ligne renvoyé au client : seuls les caractères de contrôle hors tabulation/retour à la ligne sont retirés. */
export function cleanText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max);
}

/** Message-ID exploitable dans In-Reply-To / References : « <…> » sans espace ni contrôle, sinon null. */
export function cleanMessageId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // eslint-disable-next-line no-control-regex
  return /^<[^\s<>\x00-\x1f\x7f-\uffff]{1,250}>$/.test(trimmed) ? trimmed : null;
}

/** Extrait les Message-ID valides d'un en-tête References hostile (borné). */
export function parseReferences(value: unknown, max = 20): string[] {
  if (typeof value !== 'string') return [];
  const ids = value.match(/<[^\s<>]{1,250}>/g) ?? [];
  const clean = ids.map(cleanMessageId).filter((id): id is string => id !== null);
  return clean.slice(-max);
}

/** Type MIME déclaré, réduit à « type/sous-type » ; valeur inoffensive par défaut. Purement informatif. */
export function cleanContentType(value: unknown): string {
  if (typeof value !== 'string') return 'application/octet-stream';
  const type = value.split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(type) ? type : 'application/octet-stream';
}

// ───────────────────────────── Noms de fichiers ─────────────────────────────

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const DEFAULT_FILENAME = 'piece-jointe';

/**
 * Nom de fichier sûr à partir d'un nom hostile : aucun séparateur de chemin, caractère de contrôle,
 * caractère de direction d'écriture (U+202E masque l'extension réelle), caractère réservé Windows,
 * point initial ou final ; longueur bornée en conservant l'extension.
 */
export function sanitizeFilename(input: unknown, fallback = DEFAULT_FILENAME): string {
  let name = typeof input === 'string' ? input : '';
  try {
    name = name.normalize('NFC');
  } catch {
    name = '';
  }
  name = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/[\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g, '')
    // Surrogats isolés : interdits dans encodeURIComponent.
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
  // Seul le dernier segment d'un chemin est conservé.
  name = name.split(/[/\\]/).pop() ?? '';
  name = name
    .replace(/[<>:"|?*;%]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (name.length > 150) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 150 - ext.length).replace(/[.\s]+$/, '') + ext;
  }
  if (name === '') return fallback;
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  return name;
}

/**
 * En-tête Content-Disposition forçant le téléchargement (RFC 6266 / RFC 5987) :
 * `attachment; filename="repli-ascii"; filename*=UTF-8''nom-encodé`.
 */
export function attachmentDisposition(filename: unknown): string {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
