import type { MailAttachment, MailFolder, MailMessageDetail, MailMessageSummary } from '@shared/api-types';
import { ImapFlow, type FetchMessageObject, type ImapFlowOptions, type ListResponse } from 'imapflow';
import { simpleParser } from 'mailparser';
import { AppError, badRequest, notFound, rateLimited, upstream } from '../../core/errors.js';
import { accountPassword, recheckAccess, type BoundAccount, type MailAccountRow } from './accounts.js';
import { buildPreview, collectAttachments, findTextPart, leafFilename, leafParts, leafSize, toMailAddress, toMailAddresses, type TextPartRef } from './mime.js';
import { cleanLine, cleanMessageId, cleanText, parseReferences, sanitizeMailHtml } from './sanitize.js';
import { LIMITS, tlsPolicy } from './validation.js';

/**
 * Accès IMAP. Une connexion par opération (aucune connexion partagée entre comptes ni entre requêtes),
 * fermée dans tous les cas, avec délai maximal et nombre de connexions simultanées borné par compte.
 */

const CONNECT_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 45_000;
const LOCK_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_PER_ACCOUNT = 3;
const MAX_QUEUED_PER_ACCOUNT = 20;

// ───────────────────────────── Erreurs ─────────────────────────────

export type MailFailure = 'timeout' | 'auth' | 'tls' | 'network' | 'rejected' | 'unknown';

const FAILURE_MESSAGES: Record<MailFailure, string> = {
  timeout: 'Le serveur de messagerie ne répond pas (délai dépassé)',
  auth: 'Authentification refusée par le serveur de messagerie',
  tls: 'Connexion sécurisée (TLS) impossible : certificat invalide ou chiffrement non proposé par le serveur',
  network: 'Serveur de messagerie injoignable',
  rejected: 'Le serveur de messagerie a refusé le message (expéditeur ou destinataire non accepté)',
  unknown: 'Le serveur de messagerie a renvoyé une erreur',
};

const TIMEOUT_CODES = new Set(['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'ETIMEOUT', 'ETIMEDOUT', 'LockTimeout', 'TC_OPERATION_TIMEOUT']);
const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE', 'EDNS', 'ECONNECTION', 'ESOCKET',
  'NoConnection', 'EConnectionClosed', 'ClosedAfterConnectText', 'ClosedAfterConnectTLS',
]);
const TLS_CODES = new Set([
  'ETLS', 'TC_TLS_REQUIRED', 'STARTTLS_INJECTION', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH', 'CERT_UNTRUSTED', 'CERT_REVOKED', 'EPROTO',
]);

class InternalMailError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

interface ErrorLike {
  code?: unknown;
  authenticationFailed?: unknown;
  tlsFailed?: unknown;
  mailboxMissing?: unknown;
  responseCode?: unknown;
}

/** Classe une erreur IMAP/SMTP sans jamais en reprendre le texte (qui peut contenir la réponse brute du serveur). */
export function classifyMailError(err: unknown): MailFailure {
  const e = (typeof err === 'object' && err !== null ? err : {}) as ErrorLike;
  const code = typeof e.code === 'string' ? e.code : '';
  if (e.authenticationFailed === true || code === 'EAUTH' || code === 'ENOAUTH') return 'auth';
  if (e.tlsFailed === true || TLS_CODES.has(code) || code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL')) return 'tls';
  if (TIMEOUT_CODES.has(code)) return 'timeout';
  if (NETWORK_CODES.has(code)) return 'network';
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return 'rejected';
  return 'unknown';
}

/**
 * Convertit toute erreur en `AppError` au message sobre. Ni la réponse du serveur, ni l'hôte, ni l'identifiant
 * n'y figurent ; `details.reason` donne la catégorie (timeout, auth, tls, network, rejected, unknown).
 */
export function toMailError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (typeof err === 'object' && err !== null && (err as ErrorLike).mailboxMissing === true) return notFound('Dossier introuvable');
  const reason = classifyMailError(err);
  return upstream('mail', FAILURE_MESSAGES[reason], { reason });
}

// ───────────────────────────── Connexions ─────────────────────────────

/** Options de connexion IMAP : TLS implicite ou STARTTLS exigé, certificat vérifié, journalisation coupée. */
export function imapOptions(account: MailAccountRow, password: string): ImapFlowOptions {
  const policy = tlsPolicy(account.imap_host, account.imap_secure === 1);
  return {
    host: account.imap_host,
    port: account.imap_port,
    secure: policy.implicitTls,
    // Sans TLS implicite : STARTTLS obligatoire (jamais « si disponible », qu'un attaquant sur le chemin peut retirer).
    ...(policy.implicitTls ? {} : { doSTARTTLS: policy.requireStartTls }),
    auth: { user: account.username, pass: password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    // Le journal d'imapflow contiendrait le dialogue IMAP : il est désactivé.
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    // Un serveur hostile ou défaillant ne peut pas faire allouer une réponse démesurée.
    maxLiteralSize: 48 * 1024 * 1024,
    maxResponseSize: 64 * 1024 * 1024,
    clientInfo: { name: 'TalCloud Panel' },
  };
}

interface Gate {
  active: number;
  queue: (() => void)[];
}
const gates = new Map<number, Gate>();

async function acquire(accountId: number): Promise<() => void> {
  let gate = gates.get(accountId);
  if (!gate) {
    gate = { active: 0, queue: [] };
    gates.set(accountId, gate);
  }
  const g = gate;
  if (g.active >= MAX_CONCURRENT_PER_ACCOUNT) {
    if (g.queue.length >= MAX_QUEUED_PER_ACCOUNT) throw rateLimited('Trop d’opérations simultanées sur ce compte de messagerie, réessayez');
    await new Promise<void>((resolve) => g.queue.push(resolve));
  } else {
    g.active += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = g.queue.shift();
    // Le jeton est transmis directement au suivant : `active` ne change pas.
    if (next) next();
    else {
      g.active -= 1;
      if (g.active === 0) gates.delete(accountId);
    }
  };
}

async function closeQuietly(client: ImapFlow): Promise<void> {
  try {
    if (client.usable) {
      await Promise.race([client.logout(), new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref())]);
    }
  } catch {
    // La fermeture brutale ci-dessous suffit.
  }
  try {
    client.close();
  } catch {
    // Déjà fermée.
  }
}

/**
 * Ouvre une connexion IMAP pour CE compte, exécute `fn`, puis ferme la connexion quoi qu'il arrive.
 * Toute erreur est convertie en `AppError` sobre.
 */
export async function withImap<T>(account: BoundAccount, fn: (client: ImapFlow) => Promise<T>, timeoutMs = OPERATION_TIMEOUT_MS): Promise<T> {
  const release = await acquire(account.id);
  let client: ImapFlow | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    // Droit revérifié APRÈS l'attente dans la file : une boîte devenue personnelle à l'autre administrateur (ou
    // supprimée) fait échouer l'opération en 404 ; la ligne RELUE sert à la connexion.
    const current = recheckAccess(account);
    const policy = tlsPolicy(current.imap_host, current.imap_secure === 1);
    client = new ImapFlow(imapOptions(current, accountPassword(current)));
    const c = client;
    // Sans écouteur, un évènement « error » tardif ferait tomber le processus.
    c.on('error', () => undefined);
    const work = (async () => {
      await c.connect();
      // Défense en profondeur : aucune commande n'est envoyée sur une connexion restée en clair.
      if (!policy.cleartextAllowed && c.secureConnection !== true) throw new InternalMailError('TC_TLS_REQUIRED');
      // Et de nouveau après la connexion (qui peut être longue), avant toute lecture ou écriture.
      recheckAccess(account);
      return fn(c);
    })();
    // Si le délai gagne la course, la connexion est fermée dans `finally` et `work` échoue : rejet déjà traité.
    work.catch(() => undefined);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new InternalMailError('TC_OPERATION_TIMEOUT')), timeoutMs);
    });
    return await Promise.race([work, timeout]);
  } catch (err) {
    throw toMailError(err);
  } finally {
    if (timer) clearTimeout(timer);
    if (client) await closeQuietly(client);
    release();
  }
}

/** Verrou de boîte libéré dans tous les cas. `readOnly` (EXAMINE) pour toutes les lectures : aucun état modifié. */
async function withMailbox<T>(client: ImapFlow, folder: string, readOnly: boolean, fn: () => Promise<T>): Promise<T> {
  const lock = await client.getMailboxLock(folder, { readOnly, acquireTimeout: LOCK_TIMEOUT_MS });
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// ───────────────────────────── Dossiers ─────────────────────────────

const SPECIAL_USE: Record<string, NonNullable<MailFolder['specialUse']>> = {
  '\\inbox': 'inbox',
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'junk',
  '\\archive': 'archive',
};
const SPECIAL_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];

export function normalizeSpecialUse(folder: Pick<ListResponse, 'path' | 'specialUse'>): MailFolder['specialUse'] {
  if (folder.path.toUpperCase() === 'INBOX') return 'inbox';
  return SPECIAL_USE[(folder.specialUse ?? '').toLowerCase()] ?? null;
}

const selectable = (folder: ListResponse): boolean => !folder.flags?.has('\\Noselect') && !folder.flags?.has('\\NonExistent');

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

export async function listFolders(account: BoundAccount): Promise<MailFolder[]> {
  const folders = await withImap(account, (client) => client.list({ statusQuery: { messages: true, unseen: true } }));
  const rank = (f: MailFolder): number => (f.specialUse ? SPECIAL_ORDER.indexOf(f.specialUse) : SPECIAL_ORDER.length);
  return folders
    .filter(selectable)
    .slice(0, 500)
    .map((folder) => ({
      path: folder.path,
      name: cleanLine(folder.name, 200) || folder.path,
      specialUse: normalizeSpecialUse(folder),
      unread: count(folder.status?.unseen),
      total: count(folder.status?.messages),
    }))
    .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

async function findSpecialFolder(client: ImapFlow, use: NonNullable<MailFolder['specialUse']>): Promise<string | null> {
  const folders = await client.list();
  return folders.filter(selectable).find((folder) => normalizeSpecialUse(folder) === use)?.path ?? null;
}

export async function unreadCount(account: BoundAccount): Promise<number> {
  return withImap(
    account,
    async (client) => {
      const status = await client.status('INBOX', { unseen: true });
      if (status === false) throw new InternalMailError('TC_STATUS_FAILED');
      return count(status.unseen);
    },
    20_000,
  );
}

/** Test de connexion : authentification IMAP réussie sur une connexion chiffrée. */
export async function testImap(account: BoundAccount): Promise<void> {
  await withImap(account, (client) => client.noop(), 20_000);
}

// ───────────────────────────── Messages ─────────────────────────────

function toIsoDate(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const date = candidate instanceof Date ? candidate : typeof candidate === 'string' && candidate !== '' ? new Date(candidate) : null;
    if (date && !Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date(0).toISOString();
}

function toSummary(message: FetchMessageObject, folder: string, attachments: MailAttachment[], preview: string): MailMessageSummary {
  const envelope = message.envelope ?? {};
  const flags = message.flags ?? new Set<string>();
  return {
    uid: message.uid,
    folder,
    from: toMailAddress(envelope.from?.[0]),
    to: toMailAddresses(envelope.to),
    subject: cleanLine(envelope.subject, 500),
    date: toIsoDate(envelope.date, message.internalDate),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    hasAttachments: attachments.length > 0,
    preview,
  };
}

const SUMMARY_QUERY = { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true } as const;
const MAX_PREVIEW_GROUPS = 4;

/** Aperçus : le début de la partie texte de chaque message (quelques centaines d'octets), jamais le corps entier. */
async function fetchPreviews(client: ImapFlow, messages: FetchMessageObject[]): Promise<Map<number, string>> {
  const previews = new Map<number, string>();
  const refs = new Map<number, TextPartRef>();
  const groups = new Map<string, number[]>();
  for (const message of messages) {
    const ref = findTextPart(message.bodyStructure);
    if (!ref) continue;
    refs.set(message.uid, ref);
    const key = `${ref.part}|${ref.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), message.uid]);
  }
  const largest = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, MAX_PREVIEW_GROUPS);
  for (const [key, uids] of largest) {
    const [part, kind] = key.split('|') as [string, string];
    const rows = await client.fetchAll(uids, { uid: true, bodyParts: [{ key: part, start: 0, maxLength: kind === 'html' ? 4096 : 600 }] }, { uid: true });
    for (const row of rows) {
      const ref = refs.get(row.uid);
      const chunk = row.bodyParts ? [...row.bodyParts.values()][0] : undefined;
      if (ref && chunk) previews.set(row.uid, buildPreview(chunk, ref));
    }
  }
  return previews;
}

export interface ListParams {
  folder: string;
  page: number;
  pageSize: number;
  search?: string | undefined;
}

export async function listMessages(account: BoundAccount, params: ListParams): Promise<{ messages: MailMessageSummary[]; total: number }> {
  return withImap(account, (client) =>
    withMailbox(client, params.folder, true, async () => {
      const offset = (params.page - 1) * params.pageSize;
      let total: number;
      let rows: FetchMessageObject[];

      if (params.search) {
        const term = params.search;
        const found = await client.search({ or: [{ subject: term }, { from: term }, { body: term }] }, { uid: true });
        const uids = (Array.isArray(found) ? found : []).filter((uid) => Number.isInteger(uid) && uid > 0).sort((a, b) => b - a);
        total = uids.length;
        const pageUids = uids.slice(offset, offset + params.pageSize);
        rows = pageUids.length ? await client.fetchAll(pageUids, SUMMARY_QUERY, { uid: true }) : [];
        rows.sort((a, b) => b.uid - a.uid);
      } else {
        total = client.mailbox ? count(client.mailbox.exists) : 0;
        // Numéros de séquence : le plus grand est le message le plus récent.
        const high = total - offset;
        const low = Math.max(1, high - params.pageSize + 1);
        rows = high >= 1 ? await client.fetchAll(`${low}:${high}`, SUMMARY_QUERY) : [];
        rows.sort((a, b) => b.seq - a.seq);
      }

      let previews = new Map<number, string>();
      try {
        previews = await fetchPreviews(client, rows);
      } catch {
        // L'aperçu est facultatif : la liste reste affichable sans lui.
      }
      const messages = rows.map((row) => toSummary(row, params.folder, collectAttachments(row.bodyStructure), previews.get(row.uid) ?? ''));
      return { messages, total };
    }),
  );
}

/** Détail d'un message, sans la fiche WHMCS (ajoutée par la route). */
export async function readMessage(account: BoundAccount, folder: string, uid: number): Promise<Omit<MailMessageDetail, 'whmcsClient'>> {
  const message = await withImap(account, (client) =>
    withMailbox(client, folder, true, async () => {
      // BODY.PEEK en lecture seule : lire un message ne le marque jamais « lu ».
      const row = await client.fetchOne(uid, { ...SUMMARY_QUERY, source: { start: 0, maxLength: LIMITS.sourceBytes } }, { uid: true });
      if (!row) throw notFound('Message introuvable');
      return row;
    }),
  );

  const attachments = collectAttachments(message.bodyStructure);
  let html: string | null = null;
  let text: string | null = null;
  let remoteContentBlocked = false;
  let messageId = cleanMessageId(message.envelope?.messageId);

  if (message.source && message.source.length > 0) {
    let parsed;
    try {
      // keepCidLinks : mailparser ne doit PAS convertir lui-même les « cid: » en data: (il reprendrait le type
      // déclaré par l'expéditeur, p. ex. text/html). La conversion est faite, filtrée, par sanitizeMailHtml.
      parsed = await simpleParser(message.source, { keepCidLinks: true, skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
    } catch {
      throw upstream('mail', 'Ce message est illisible (format invalide)', { reason: 'unknown' });
    }
    if (typeof parsed.text === 'string' && parsed.text.trim() !== '') text = cleanText(parsed.text, LIMITS.textChars).trimEnd();
    if (typeof parsed.html === 'string' && parsed.html !== '' && Buffer.byteLength(parsed.html) <= LIMITS.htmlBytes) {
      const inlineImages = new Map<string, Buffer>();
      for (const attachment of parsed.attachments.slice(0, 100)) {
        const cid = (attachment.cid ?? attachment.contentId ?? '').replace(/^<|>$/g, '');
        if (cid !== '' && Buffer.isBuffer(attachment.content)) inlineImages.set(cid, attachment.content);
      }
      const sanitized = sanitizeMailHtml(parsed.html, inlineImages);
      remoteContentBlocked = sanitized.remoteContentBlocked;
      if (sanitized.html.trim() !== '') html = sanitized.html;
    }
    messageId ??= cleanMessageId(parsed.messageId);
  }

  const envelope = message.envelope ?? {};
  return {
    ...toSummary(message, folder, attachments, cleanLine(text ?? '', LIMITS.preview)),
    cc: toMailAddresses(envelope.cc),
    replyTo: toMailAddresses(envelope.replyTo),
    messageId,
    html,
    text,
    remoteContentBlocked,
    attachments,
  };
}

export interface DownloadedAttachment {
  filename: string;
  content: Buffer;
}

export async function downloadAttachment(account: BoundAccount, folder: string, uid: number, partId: string): Promise<DownloadedAttachment> {
  return withImap(
    account,
    (client) =>
      withMailbox(client, folder, true, async () => {
        const row = await client.fetchOne(uid, { uid: true, bodyStructure: true }, { uid: true });
        if (!row) throw notFound('Message introuvable');
        // L'identifiant doit désigner une partie réelle de CE message.
        const leaf = leafParts(row.bodyStructure).find((candidate) => candidate.part === partId);
        if (!leaf) throw notFound('Pièce jointe introuvable');
        if (leafSize(leaf) > LIMITS.downloadBytes) throw badRequest('Pièce jointe trop volumineuse pour être téléchargée depuis le panel (25 Mo maximum)');

        const download = await client.download(uid, partId, { uid: true, maxBytes: LIMITS.downloadBytes + 1 });
        if (!download.content) throw notFound('Pièce jointe introuvable');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of download.content) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          size += buffer.length;
          if (size > LIMITS.downloadBytes) {
            download.content.destroy();
            throw badRequest('Pièce jointe trop volumineuse pour être téléchargée depuis le panel (25 Mo maximum)');
          }
          chunks.push(buffer);
        }
        return { filename: leafFilename(leaf), content: Buffer.concat(chunks) };
      }),
    120_000,
  );
}

async function assertMessageExists(client: ImapFlow, uid: number): Promise<void> {
  const row = await client.fetchOne(uid, { uid: true }, { uid: true });
  if (!row) throw notFound('Message introuvable');
}

export interface FlagChange {
  seen?: boolean | undefined;
  flagged?: boolean | undefined;
}

export async function setFlags(account: BoundAccount, folder: string, uid: number, change: FlagChange): Promise<{ seen: boolean; flagged: boolean; answered: boolean }> {
  return withImap(account, (client) =>
    withMailbox(client, folder, false, async () => {
      await assertMessageExists(client, uid);
      const add: string[] = [];
      const remove: string[] = [];
      if (change.seen !== undefined) (change.seen ? add : remove).push('\\Seen');
      if (change.flagged !== undefined) (change.flagged ? add : remove).push('\\Flagged');
      if (add.length && !(await client.messageFlagsAdd(uid, add, { uid: true }))) throw new InternalMailError('TC_STORE_FAILED');
      if (remove.length && !(await client.messageFlagsRemove(uid, remove, { uid: true }))) throw new InternalMailError('TC_STORE_FAILED');
      const row = await client.fetchOne(uid, { uid: true, flags: true }, { uid: true });
      const flags = (row ? row.flags : undefined) ?? new Set<string>();
      return { seen: flags.has('\\Seen'), flagged: flags.has('\\Flagged'), answered: flags.has('\\Answered') };
    }),
  );
}

export async function moveMessage(account: BoundAccount, folder: string, uid: number, destination: string): Promise<void> {
  if (destination === folder) throw badRequest('Le message est déjà dans ce dossier');
  await withImap(account, (client) =>
    withMailbox(client, folder, false, async () => {
      await assertMessageExists(client, uid);
      let moved;
      try {
        moved = await client.messageMove(uid, destination, { uid: true });
      } catch (err) {
        if (classifyMailError(err) !== 'unknown') throw err;
        moved = false;
      }
      if (!moved) throw upstream('mail', 'Déplacement refusé par le serveur de messagerie (dossier de destination introuvable ?)', { reason: 'rejected' });
    }),
  );
}

/** Supprime un message : vers la corbeille si elle existe (et qu'il n'y est pas déjà), sinon suppression définitive. */
export async function deleteMessage(account: BoundAccount, folder: string, uid: number): Promise<{ movedToTrash: boolean }> {
  return withImap(account, async (client) => {
    const trash = await findSpecialFolder(client, 'trash');
    return withMailbox(client, folder, false, async () => {
      await assertMessageExists(client, uid);
      if (trash !== null && trash !== folder) {
        if (!(await client.messageMove(uid, trash, { uid: true }))) throw new InternalMailError('TC_MOVE_FAILED');
        return { movedToTrash: true };
      }
      if (!(await client.messageDelete(uid, { uid: true }))) throw new InternalMailError('TC_DELETE_FAILED');
      return { movedToTrash: false };
    });
  });
}

// ───────────────────────────── Envoi : réponse et copie ─────────────────────────────

export interface ReplyContext {
  /** Message-ID du message d'origine (validé), ou null s'il n'en a pas d'exploitable. */
  messageId: string | null;
  references: string[];
}

/** En-têtes de fil du message auquel on répond. Les valeurs viennent d'un mail hostile : elles sont filtrées. */
export async function replyContext(account: BoundAccount, folder: string, uid: number): Promise<ReplyContext> {
  return withImap(account, (client) =>
    withMailbox(client, folder, true, async () => {
      const row = await client.fetchOne(uid, { uid: true, envelope: true, headers: ['references'] }, { uid: true });
      if (!row) throw notFound('Message d’origine introuvable');
      const header = row.headers ? row.headers.toString('latin1').replace(/\r?\n[ \t]+/g, ' ') : '';
      const references = parseReferences(/^references:(.*)$/im.exec(header)?.[1] ?? '');
      return { messageId: cleanMessageId(row.envelope?.messageId), references };
    }),
  );
}

export interface AfterSendResult {
  savedToSent: boolean;
  markedAnswered: boolean;
}

/**
 * Après un envoi réussi : copie dans « Envoyés » (APPEND) et marquage \Answered de l'original.
 * Au mieux : le mail est déjà parti, un échec ici ne doit pas faire croire à un échec d'envoi.
 */
export async function afterSend(account: BoundAccount, raw: Buffer | null, reply: { folder: string; uid: number } | null): Promise<AfterSendResult> {
  const result: AfterSendResult = { savedToSent: false, markedAnswered: false };
  try {
    await withImap(account, async (client) => {
      if (raw) {
        try {
          const sent = await findSpecialFolder(client, 'sent');
          if (sent !== null) result.savedToSent = Boolean(await client.append(sent, raw, ['\\Seen']));
        } catch {
          // Copie non enregistrée : signalé dans le journal d'audit par l'appelant.
        }
      }
      if (reply) {
        try {
          await withMailbox(client, reply.folder, false, async () => {
            result.markedAnswered = await client.messageFlagsAdd(reply.uid, ['\\Answered'], { uid: true });
          });
        } catch {
          // Idem.
        }
      }
    }, 25_000);
  } catch {
    // Connexion impossible après l'envoi : rien à annuler.
  }
  return result;
}
