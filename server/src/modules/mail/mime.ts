import type { MailAddress, MailAttachment } from '@shared/api-types';
import type { MessageAddressObject, MessageStructureObject } from 'imapflow';
import sanitizeHtml from 'sanitize-html';
import { cleanContentType, cleanLine, sanitizeFilename } from './sanitize.js';
import { LIMITS } from './validation.js';

/**
 * Lecture de la structure MIME (BODYSTRUCTURE) d'un message : pièces jointes, partie texte, aperçu.
 * Tout ce qui vient d'ici est du contenu hostile : chaque valeur est bornée et nettoyée.
 */

const MAX_DEPTH = 20;
const MAX_PARTS = 200;

function decodeBytes(bytes: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder((charset ?? 'utf-8').trim().toLowerCase() || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Décode les « encoded-words » RFC 2047 (=?utf-8?B?…?=) d'un paramètre MIME. */
export function decodeMimeWords(value: string): string {
  if (!value.includes('=?')) return value;
  return value
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([A-Za-z0-9._-]{1,40})(?:\*[A-Za-z0-9-]*)?\?([bBqQ])\?([^?\s]{0,2000})\?=/g, (_all, charset: string, encoding: string, data: string) => {
      const bytes =
        encoding.toLowerCase() === 'b'
          ? Buffer.from(data, 'base64')
          : Buffer.from(
              data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
              'latin1',
            );
      return decodeBytes(bytes, charset);
    });
}

function partFilename(node: MessageStructureObject): string | null {
  const raw = node.dispositionParameters?.filename ?? node.parameters?.name;
  return typeof raw === 'string' && raw !== '' ? decodeMimeWords(raw) : null;
}

/** Taille décodée approximative d'une partie (le BODYSTRUCTURE donne la taille encodée). */
function decodedSize(node: MessageStructureObject): number {
  const size = typeof node.size === 'number' && Number.isFinite(node.size) && node.size > 0 ? Math.floor(node.size) : 0;
  return node.encoding === 'base64' ? Math.floor((size * 3) / 4) : size;
}

export interface LeafPart {
  /** Numéro de partie IMAP (« 1 », « 1.2 »…). */
  part: string;
  node: MessageStructureObject;
  parentType: string | null;
}

/** Parties feuilles du message (un message/rfc822 joint est une feuille : on ne descend pas dedans). */
export function leafParts(root: MessageStructureObject | undefined): LeafPart[] {
  const leaves: LeafPart[] = [];
  const walk = (node: MessageStructureObject, parentType: string | null, depth: number): void => {
    if (depth > MAX_DEPTH || leaves.length >= MAX_PARTS) return;
    const type = typeof node.type === 'string' ? node.type.toLowerCase() : '';
    if (type.startsWith('multipart/') && Array.isArray(node.childNodes)) {
      for (const child of node.childNodes) walk(child, type, depth + 1);
      return;
    }
    const part = typeof node.part === 'string' && /^\d+(\.\d+)*$/.test(node.part) ? node.part : '1';
    leaves.push({ part, node, parentType });
  };
  if (root) walk(root, null, 0);
  return leaves;
}

const isBodyText = ({ node }: LeafPart): boolean => {
  const type = (node.type ?? '').toLowerCase();
  return (type === 'text/plain' || type === 'text/html') && node.disposition !== 'attachment' && partFilename(node) === null;
};

/** Image intégrée au HTML par « cid: » : affichée dans le corps, pas listée comme pièce jointe. */
const isInlineRelated = ({ node, parentType }: LeafPart): boolean =>
  parentType === 'multipart/related' && typeof node.id === 'string' && node.id !== '' && node.disposition !== 'attachment' && (node.type ?? '').toLowerCase().startsWith('image/');

export function leafFilename(leaf: LeafPart): string {
  const type = (leaf.node.type ?? '').toLowerCase();
  return sanitizeFilename(partFilename(leaf.node), type === 'message/rfc822' ? 'message.eml' : `piece-jointe-${leaf.part}`);
}

export const leafSize = (leaf: LeafPart): number => decodedSize(leaf.node);

/** Pièces jointes d'un message d'après sa structure (sans rien télécharger). */
export function collectAttachments(root: MessageStructureObject | undefined): MailAttachment[] {
  return leafParts(root)
    .filter((leaf) => !isBodyText(leaf) && !isInlineRelated(leaf))
    .map((leaf) => ({
      id: leaf.part,
      filename: leafFilename(leaf),
      contentType: cleanContentType(leaf.node.type),
      size: leafSize(leaf),
    }));
}

export interface TextPartRef {
  part: string;
  kind: 'plain' | 'html';
  encoding: string;
  charset: string | undefined;
}

/** Partie texte à utiliser pour l'aperçu : text/plain de préférence, sinon text/html. */
export function findTextPart(root: MessageStructureObject | undefined): TextPartRef | null {
  const bodies = leafParts(root).filter(isBodyText);
  const chosen = bodies.find((leaf) => leaf.node.type.toLowerCase() === 'text/plain') ?? bodies[0];
  if (!chosen) return null;
  return {
    part: chosen.part,
    kind: chosen.node.type.toLowerCase() === 'text/plain' ? 'plain' : 'html',
    encoding: (chosen.node.encoding ?? '7bit').toLowerCase(),
    charset: chosen.node.parameters?.charset,
  };
}

const HTML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/**
 * Aperçu texte à partir du DÉBUT (tronqué) d'une partie texte encodée.
 * Le résultat est du texte brut, à afficher comme tel (jamais comme HTML).
 */
export function buildPreview(chunk: Buffer, ref: TextPartRef): string {
  let bytes: Buffer;
  if (ref.encoding === 'base64') {
    const b64 = chunk.toString('latin1').replace(/[^A-Za-z0-9+/]/g, '');
    bytes = Buffer.from(b64.slice(0, b64.length - (b64.length % 4)), 'base64');
  } else if (ref.encoding === 'quoted-printable') {
    bytes = Buffer.from(
      chunk
        .toString('latin1')
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
      'latin1',
    );
  } else {
    bytes = chunk;
  }
  let text = decodeBytes(bytes, ref.charset).replace(/\ufffd+$/, '');
  if (ref.kind === 'html') {
    // Un fragment coupé au milieu d'une balise est possible : la balise incomplète finale est retirée.
    text = sanitizeHtml(text.replace(/<[^>]*$/, ''), {
      allowedTags: [],
      allowedAttributes: {},
      nonTextTags: ['script', 'style', 'title', 'head', 'textarea', 'option', 'noscript', 'svg', 'math', 'template', 'xmp'],
    }).replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => HTML_ENTITIES[entity] ?? ' ');
  }
  return cleanLine(text, LIMITS.preview);
}

export function toMailAddress(input: MessageAddressObject | undefined): MailAddress | null {
  if (!input) return null;
  const address = cleanLine(input.address, 320);
  const name = cleanLine(input.name, 200);
  if (address === '' && name === '') return null;
  return { name: name === '' ? null : name, address };
}

export function toMailAddresses(list: MessageAddressObject[] | undefined, max = 100): MailAddress[] {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, max)
    .map(toMailAddress)
    .filter((a): a is MailAddress => a !== null);
}
