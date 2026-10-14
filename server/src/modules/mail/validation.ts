import ipaddr from 'ipaddr.js';
import { z } from 'zod';

/**
 * Validation de toutes les entrées du module « mail » (zod) et règles de sécurité réseau :
 * format des hôtes IMAP/SMTP, ports admis, politique TLS.
 */

// ───────────────────────────── Limites ─────────────────────────────

export const LIMITS = {
  /** Nombre maximal de comptes de messagerie. */
  accounts: 20,
  /** Destinataires (to + cc + bcc) par envoi. */
  recipients: 50,
  subject: 500,
  /** Corps texte d'un envoi (caractères). */
  text: 200_000,
  /** Pièces jointes par envoi. */
  sendAttachments: 10,
  /** Taille totale décodée des pièces jointes d'un envoi. */
  sendAttachmentsBytes: 10 * 1024 * 1024,
  /** Limite du corps JSON de la route d'envoi (base64 = +33 %, plus le reste du message). */
  sendBodyBytes: 15 * 1024 * 1024,
  /** Téléchargement d'une pièce jointe reçue. */
  downloadBytes: 25 * 1024 * 1024,
  /** Source brute lue pour afficher un message (les pièces jointes sont téléchargées à part). */
  sourceBytes: 10 * 1024 * 1024,
  /** HTML d'un message : au-delà, seul le texte est renvoyé. */
  htmlBytes: 2 * 1024 * 1024,
  /** Texte renvoyé au client (caractères). */
  textChars: 500_000,
  /** Image « cid: » intégrée au HTML : par image, et au total. */
  inlineImageBytes: 2 * 1024 * 1024,
  inlineImagesTotalBytes: 6 * 1024 * 1024,
  search: 100,
  folder: 255,
  preview: 180,
} as const;

// ───────────────────────────── Hôtes, ports, TLS ─────────────────────────────

const IMAP_WELL_KNOWN_PORTS = [143, 993];
const SMTP_WELL_KNOWN_PORTS = [25, 465, 587, 2525];

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** Dernier libellé d'un nom d'hôte : jamais purement numérique (sinon « 2852039166 » serait lu comme une IPv4). */
const LAST_LABEL = /^(?=.*[a-z])[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const BLOCKED_HOSTNAMES = new Set(['metadata', 'metadata.google.internal', 'instance-data']);
const BLOCKED_RANGES = new Set(['unspecified', 'broadcast', 'multicast', 'linkLocal']);

export type HostCheck = { ok: true; host: string; kind: 'name' | 'ipv4' | 'ipv6' } | { ok: false; reason: string };

function parseIp(host: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  // Quatre octets décimaux uniquement : les formes abrégées, octales ou hexadécimales sont refusées.
  if (ipaddr.IPv4.isValidFourPartDecimal(host)) return ipaddr.IPv4.parse(host);
  if (host.includes(':') && !host.includes('%') && ipaddr.IPv6.isValid(host)) {
    const v6 = ipaddr.IPv6.parse(host);
    return v6.isIPv4MappedAddress() ? v6.toIPv4Address() : v6;
  }
  return null;
}

/**
 * Valide le format d'un hôte IMAP/SMTP : nom d'hôte DNS ou adresse IP littérale, rien d'autre
 * (pas d'URL, de port, d'identifiants, d'espace ni de caractère de contrôle).
 * Les adresses de lien local (169.254.0.0/16, fe80::/10 — métadonnées « cloud »), non spécifiées,
 * de diffusion et de multidiffusion sont refusées.
 */
export function checkMailHost(input: string): HostCheck {
  if (typeof input !== 'string') return { ok: false, reason: 'Hôte invalide' };
  const host = input.trim().toLowerCase();
  if (host.length === 0 || host.length > 253) return { ok: false, reason: 'Hôte invalide' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f/\\@?#[\]]/.test(host)) return { ok: false, reason: "L'hôte doit être un nom de domaine ou une adresse IP, sans schéma ni chemin" };

  const ip = parseIp(host);
  if (ip) {
    if (BLOCKED_RANGES.has(ip.range())) return { ok: false, reason: "Cette plage d'adresses n'est pas autorisée" };
    return { ok: true, host: ip.toString(), kind: ip.kind() === 'ipv4' ? 'ipv4' : 'ipv6' };
  }
  if (host.includes(':')) return { ok: false, reason: 'Adresse IPv6 invalide (ne pas indiquer le port ici)' };

  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  const labels = name.split('.');
  const last = labels[labels.length - 1] ?? '';
  // « 0x7f000001 » ou « 0x7f.1 » seraient lus comme des IPv4 hexadécimales par le résolveur.
  if (!labels.every((label) => LABEL.test(label)) || !LAST_LABEL.test(last) || /^0x[0-9a-f]*$/.test(last)) return { ok: false, reason: 'Nom d’hôte invalide' };
  if (BLOCKED_HOSTNAMES.has(name)) return { ok: false, reason: "Cet hôte n'est pas autorisé" };
  return { ok: true, host: name, kind: 'name' };
}

/** Hôte en boucle locale : seul cas où une connexion sans TLS est tolérée. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost') return true;
  const ip = parseIp(h);
  return ip !== null && ip.range() === 'loopback';
}

export function isAllowedPort(kind: 'imap' | 'smtp', port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const wellKnown = kind === 'imap' ? IMAP_WELL_KNOWN_PORTS : SMTP_WELL_KNOWN_PORTS;
  // Sous 1024, seuls les ports standard de la messagerie : pas de sonde vers SSH, HTTP, etc.
  return wellKnown.includes(port) || port >= 1024;
}

export interface TlsPolicy {
  /** TLS implicite dès la connexion. */
  implicitTls: boolean;
  /** STARTTLS obligatoire (échec de connexion si le serveur ne le propose pas). */
  requireStartTls: boolean;
  /** Vrai uniquement pour un hôte en boucle locale sans TLS implicite. */
  cleartextAllowed: boolean;
}

/**
 * Politique TLS d'une connexion : TLS implicite si `secure`, sinon STARTTLS EXIGÉ.
 * Le clair n'est toléré que vers la boucle locale (relais sur la même machine).
 */
export function tlsPolicy(host: string, secure: boolean): TlsPolicy {
  if (secure) return { implicitTls: true, requireStartTls: false, cleartextAllowed: false };
  const loopback = isLoopbackHost(host);
  return { implicitTls: false, requireStartTls: !loopback, cleartextAllowed: loopback };
}

// ───────────────────────────── Chaînes sûres ─────────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINES = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export const hasControlChars = (value: string): boolean => CONTROL.test(value);

/** Adresse e-mail stricte (ASCII, « local@domaine.tld »), sans nom affiché ni commentaire. */
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidEmailAddress(value: string): boolean {
  if (typeof value !== 'string' || value.length > 254 || hasControlChars(value)) return false;
  if (!EMAIL.test(value)) return false;
  const local = value.slice(0, value.indexOf('@'));
  return !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
}

const emailAddress = z
  .string()
  .max(254)
  .refine(isValidEmailAddress, 'Adresse e-mail invalide');

/** Texte d'une seule ligne : aucun caractère de contrôle (donc aucun retour à la ligne → pas d'injection d'en-tête). */
const singleLine = (max: number, min = 1) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((v) => !hasControlChars(v), 'Caractères de contrôle ou retours à la ligne interdits');

export const folderPath = z
  .string()
  .min(1)
  .max(LIMITS.folder)
  .refine((v) => !hasControlChars(v), 'Nom de dossier invalide');

// ───────────────────────────── Paramètres d'URL ─────────────────────────────

const positiveInt = (max: number) =>
  z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .transform(Number)
    .refine((n) => n <= max);

export const accountParams = z.object({ id: positiveInt(2_147_483_647) });
export const messageParams = z.object({ id: positiveInt(2_147_483_647), uid: positiveInt(4_294_967_295) });
export const attachmentParams = z.object({
  id: positiveInt(2_147_483_647),
  uid: positiveInt(4_294_967_295),
  /** Numéro de partie MIME IMAP : « 2 », « 1.2 »… */
  attachmentId: z.string().regex(/^[1-9]\d{0,2}(\.[1-9]\d{0,2}){0,9}$/),
});

export const folderQuery = z.object({ folder: folderPath.default('INBOX') });

export const listQuery = z.object({
  folder: folderPath.default('INBOX'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z
    .string()
    .trim()
    .max(LIMITS.search)
    .refine((v) => !hasControlChars(v), 'Recherche invalide')
    .optional()
    .transform((v) => (v ? v : undefined)),
});

// ───────────────────────────── Comptes ─────────────────────────────

const host = (kind: 'imap' | 'smtp') =>
  z
    .string()
    .max(253)
    .transform((value, ctx) => {
      const check = checkMailHost(value);
      if (!check.ok) {
        ctx.addIssue({ code: 'custom', message: `Hôte ${kind.toUpperCase()} : ${check.reason}` });
        return z.NEVER;
      }
      return check.host;
    });

const port = (kind: 'imap' | 'smtp') =>
  z
    .number()
    .int()
    .refine((p) => isAllowedPort(kind, p), `Port ${kind.toUpperCase()} non autorisé (ports standard de messagerie ou ≥ 1024)`);

const password = z
  .string()
  .max(1024)
  .refine((v) => !CONTROL.test(v), 'Mot de passe invalide');

const accountBase = {
  label: singleLine(60).transform((v) => v.trim()).refine((v) => v.length > 0, 'Libellé requis'),
  address: emailAddress,
  imapHost: host('imap'),
  imapPort: port('imap'),
  imapSecure: z.boolean(),
  smtpHost: host('smtp'),
  smtpPort: port('smtp'),
  smtpSecure: z.boolean(),
  username: singleLine(255).refine((v) => !/\s/.test(v), "Identifiant invalide (pas d'espace)"),
};

const visibility = z.enum(['shared', 'personal']);

/** À la création, une boîte est partagée sauf demande explicite. */
export const accountCreateBody = z.strictObject({ ...accountBase, visibility: visibility.default('shared'), password: password.min(1, 'Mot de passe requis') });
/** En modification, un mot de passe absent ou vide laisse le mot de passe inchangé ; une visibilité absente aussi. */
export const accountUpdateBody = z.strictObject({ ...accountBase, visibility: visibility.optional(), password: password.optional() });

export type AccountCreateInput = z.infer<typeof accountCreateBody>;
export type AccountUpdateInput = z.infer<typeof accountUpdateBody>;

// ───────────────────────────── Messages ─────────────────────────────

export const flagsBody = z
  .strictObject({ seen: z.boolean().optional(), flagged: z.boolean().optional() })
  .refine((v) => v.seen !== undefined || v.flagged !== undefined, 'Aucun indicateur à modifier');

export const moveBody = z.strictObject({ destination: folderPath });

const recipients = z.array(emailAddress).max(LIMITS.recipients);

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Taille décodée d'une chaîne base64 valide. */
export function base64DecodedLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

const sendAttachment = z.strictObject({
  filename: z.string().min(1).max(255),
  contentType: z.string().max(255),
  contentBase64: z
    .string()
    .min(4)
    .refine((v) => v.length % 4 === 0 && BASE64.test(v), 'Pièce jointe : base64 invalide'),
});

/**
 * Corps de POST …/send. Objet STRICT : tout champ inconnu (« from », « html », « headers »…) est refusé —
 * l'expéditeur est toujours l'adresse du compte et le corps est toujours du texte brut.
 */
export const sendBody = z
  .strictObject({
    to: recipients.min(1, 'Au moins un destinataire'),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    subject: z
      .string()
      .max(LIMITS.subject)
      .refine((v) => !hasControlChars(v), "Objet invalide : retours à la ligne et caractères de contrôle interdits"),
    text: z
      .string()
      .max(LIMITS.text)
      .refine((v) => !CONTROL_EXCEPT_NEWLINES.test(v), 'Texte invalide : caractères de contrôle interdits'),
    inReplyTo: z.strictObject({ folder: folderPath, uid: z.number().int().min(1).max(4_294_967_295) }).optional(),
    attachments: z.array(sendAttachment).max(LIMITS.sendAttachments).optional(),
  })
  .superRefine((value, ctx) => {
    const total = value.to.length + (value.cc?.length ?? 0) + (value.bcc?.length ?? 0);
    if (total > LIMITS.recipients) ctx.addIssue({ code: 'custom', path: ['to'], message: `Trop de destinataires (maximum ${LIMITS.recipients})` });
    const bytes = (value.attachments ?? []).reduce((sum, a) => sum + base64DecodedLength(a.contentBase64), 0);
    if (bytes > LIMITS.sendAttachmentsBytes) {
      ctx.addIssue({ code: 'custom', path: ['attachments'], message: 'Pièces jointes trop volumineuses (10 Mo au total)' });
    }
  });

export type SendInput = z.infer<typeof sendBody>;
