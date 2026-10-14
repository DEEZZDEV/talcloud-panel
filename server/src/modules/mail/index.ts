import type { MailAccount, MailFolder, MailMessageDetail, MailMessageSummary, MailSendResult, MailUnreadSummary, PageMeta, WhmcsClientRef } from '@shared/api-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { securityAlert } from '../../core/alerts.js';
import { audit } from '../../core/audit.js';
import { AppError, rateLimited } from '../../core/errors.js';
import { currentUser } from '../../core/request.js';
import { findClientByEmail } from '../whmcs/service.js';
import { createAccount, deleteAccount, getAccount, listAccounts, toMailAccount, updateAccount, type MailAccountRow } from './accounts.js';
import { afterSend, deleteMessage, downloadAttachment, listFolders, listMessages, moveMessage, readMessage, replyContext, setFlags, testImap, toMailError, unreadCount } from './imap.js';
import { attachmentDisposition } from './sanitize.js';
import { buildOutgoingMessage, buildRawCopy, sendMessage, testSmtp } from './smtp.js';
import {
  LIMITS,
  accountCreateBody,
  accountParams,
  accountUpdateBody,
  attachmentParams,
  flagsBody,
  folderQuery,
  isValidEmailAddress,
  listQuery,
  messageParams,
  moveBody,
  sendBody,
} from './validation.js';

// ───────────────────────────── Journal ─────────────────────────────

const accountTarget = (row: Pick<MailAccountRow, 'id' | 'label'>): string => `compte mail #${row.id} (${row.label})`;
const messageTarget = (row: MailAccountRow, folder: string, uid: number): string => `${accountTarget(row)} · ${folder} · message ${uid}`;

interface AuditEntry {
  action: string;
  target: string | null;
  details?: Record<string, unknown>;
}

/** Exécute une action modifiant un état et la journalise, succès comme échec (jamais de contenu de mail ni de secret). */
async function audited<T>(request: FastifyRequest, entry: AuditEntry, fn: () => Promise<T> | T, onSuccess?: (result: T) => Partial<AuditEntry>): Promise<T> {
  try {
    const result = await fn();
    const extra = onSuccess?.(result) ?? {};
    audit(request, { ...entry, ...extra, details: { ...entry.details, ...extra.details }, success: true });
    return result;
  } catch (err) {
    const error = err instanceof AppError ? err.code : 'INTERNAL';
    const reason = err instanceof AppError && typeof err.details === 'object' && err.details !== null ? (err.details as { reason?: unknown }).reason : undefined;
    audit(request, { ...entry, success: false, details: { ...entry.details, error, ...(typeof reason === 'string' ? { reason } : {}) } });
    throw err;
  }
}

// ───────────────────────────── Non-lus : cache court ─────────────────────────────

const UNREAD_TTL_MS = 30_000;
interface UnreadEntry {
  at: number;
  unread: number;
  error: string | null;
}
const unreadCache = new Map<number, UnreadEntry>();
const unreadInFlight = new Map<number, Promise<UnreadEntry>>();

function invalidateUnread(accountId: number): void {
  unreadCache.delete(accountId);
  unreadInFlight.delete(accountId);
}

async function unreadFor(row: MailAccountRow): Promise<UnreadEntry> {
  const cached = unreadCache.get(row.id);
  if (cached && Date.now() - cached.at < UNREAD_TTL_MS) return cached;
  const pending = unreadInFlight.get(row.id);
  if (pending) return pending;
  const task = (async (): Promise<UnreadEntry> => {
    try {
      return { at: Date.now(), unread: await unreadCount(row), error: null };
    } catch (err) {
      // Message sobre uniquement : jamais la réponse du serveur.
      return { at: Date.now(), unread: 0, error: toMailError(err).message };
    }
  })();
  unreadInFlight.set(row.id, task);
  try {
    const entry = await task;
    // Le compte a pu être modifié pendant l'interrogation : le résultat n'est alors pas mis en cache.
    if (unreadInFlight.get(row.id) === task) unreadCache.set(row.id, entry);
    return entry;
  } finally {
    if (unreadInFlight.get(row.id) === task) unreadInFlight.delete(row.id);
  }
}

// ───────────────────────────── Envoi : limitation de débit ─────────────────────────────

const SEND_WINDOW_MS = 10 * 60_000;
const SEND_MAX_PER_WINDOW = 20;
const sendHistory = new Map<number, number[]>();

/** Fenêtre glissante par administrateur. Retourne 0 si l'envoi est permis, sinon le délai d'attente en secondes. */
function takeSendSlot(userId: number, now = Date.now()): number {
  const recent = (sendHistory.get(userId) ?? []).filter((at) => now - at < SEND_WINDOW_MS);
  if (recent.length >= SEND_MAX_PER_WINDOW) {
    sendHistory.set(userId, recent);
    return Math.max(1, Math.ceil((recent[0]! + SEND_WINDOW_MS - now) / 1000));
  }
  recent.push(now);
  sendHistory.set(userId, recent);
  return 0;
}

/** Les serveurs Google enregistrent eux-mêmes chaque envoi SMTP dans « Messages envoyés ». */
const savesSentCopyItself = (row: MailAccountRow): boolean => /(^|\.)(gmail|googlemail)\.com$/i.test(row.smtp_host);

/** Prévient les deux administrateurs de toute modification d'un compte de messagerie. */
function alertAccountChange(request: FastifyRequest, verb: string, address: string): void {
  const user = currentUser(request);
  securityAlert({
    kind: 'settings_changed',
    severity: 'warning',
    title: `Compte mail ${verb}`,
    summary: `Le compte de messagerie ${address} a été ${verb} par ${user.username}.`,
    facts: [
      ['Adresse IP', request.client.ip],
      ['Navigateur', request.client.userAgent],
    ],
    userId: user.id,
  });
}

// ───────────────────────────── Routes ─────────────────────────────

export default async function mailRoutes(app: FastifyInstance): Promise<void> {
  // ── Comptes ──

  app.get('/api/mail/accounts', async (): Promise<{ data: MailAccount[] }> => ({ data: listAccounts().map(toMailAccount) }));

  app.post('/api/mail/accounts', { config: { stepUp: true } }, async (request, reply): Promise<{ data: MailAccount }> => {
    const input = accountCreateBody.parse(request.body);
    const row = await audited(
      request,
      { action: 'mail.account.create', target: null, details: { address: input.address, imapHost: input.imapHost, smtpHost: input.smtpHost } },
      () => createAccount(input),
      (created) => ({ target: accountTarget(created) }),
    );
    alertAccountChange(request, 'ajouté', row.address);
    reply.status(201);
    return { data: toMailAccount(row) };
  });

  app.put('/api/mail/accounts/:id', { config: { stepUp: true } }, async (request): Promise<{ data: MailAccount }> => {
    const { id } = accountParams.parse(request.params);
    const input = accountUpdateBody.parse(request.body);
    const before = getAccount(id);
    const result = await audited(
      request,
      { action: 'mail.account.update', target: accountTarget(before), details: { address: input.address, imapHost: input.imapHost, smtpHost: input.smtpHost } },
      () => updateAccount(id, input),
      (updated) => ({ details: { passwordChanged: updated.passwordChanged } }),
    );
    invalidateUnread(id);
    alertAccountChange(request, 'modifié', result.row.address);
    return { data: toMailAccount(result.row) };
  });

  app.delete('/api/mail/accounts/:id', { config: { stepUp: true } }, async (request): Promise<{ data: { deleted: true } }> => {
    const { id } = accountParams.parse(request.params);
    const before = getAccount(id);
    await audited(request, { action: 'mail.account.delete', target: accountTarget(before), details: { address: before.address } }, () => deleteAccount(id));
    invalidateUnread(id);
    alertAccountChange(request, 'supprimé', before.address);
    return { data: { deleted: true } };
  });

  app.post('/api/mail/accounts/:id/test', async (request) => {
    const { id } = accountParams.parse(request.params);
    const row = getAccount(id);
    const [imap, smtp] = await Promise.allSettled([testImap(row), testSmtp(row)]);
    const part = (name: string, outcome: PromiseSettledResult<void>) =>
      outcome.status === 'fulfilled' ? { ok: true, message: `${name} : connexion réussie` } : { ok: false, message: `${name} : ${toMailError(outcome.reason).message}` };
    const results = { imap: part('IMAP', imap), smtp: part('SMTP', smtp) };
    const ok = results.imap.ok && results.smtp.ok;
    audit(request, { action: 'mail.account.test', target: accountTarget(row), success: ok, details: { imap: results.imap.ok, smtp: results.smtp.ok } });
    return { data: { ok, message: ok ? 'Connexions IMAP et SMTP réussies' : `${results.imap.message} · ${results.smtp.message}`, ...results } };
  });

  // ── Lecture ──

  app.get('/api/mail/accounts/:id/folders', async (request): Promise<{ data: MailFolder[] }> => {
    const { id } = accountParams.parse(request.params);
    return { data: await listFolders(getAccount(id)) };
  });

  app.get('/api/mail/accounts/:id/messages', async (request): Promise<{ data: MailMessageSummary[]; meta: PageMeta }> => {
    const { id } = accountParams.parse(request.params);
    const query = listQuery.parse(request.query);
    const { messages, total } = await listMessages(getAccount(id), query);
    return { data: messages, meta: { page: query.page, pageSize: query.pageSize, total } };
  });

  app.get('/api/mail/accounts/:id/messages/:uid', async (request): Promise<{ data: MailMessageDetail }> => {
    const { id, uid } = messageParams.parse(request.params);
    const { folder } = folderQuery.parse(request.query);
    const message = await readMessage(getAccount(id), folder, uid);
    let whmcsClient: WhmcsClientRef | null = null;
    const sender = message.from?.address ?? '';
    if (isValidEmailAddress(sender)) {
      try {
        whmcsClient = await findClientByEmail(sender);
      } catch {
        whmcsClient = null;
      }
    }
    return { data: { ...message, whmcsClient } };
  });

  app.get('/api/mail/accounts/:id/messages/:uid/attachments/:attachmentId', async (request, reply) => {
    const { id, uid, attachmentId } = attachmentParams.parse(request.params);
    const { folder } = folderQuery.parse(request.query);
    const file = await downloadAttachment(getAccount(id), folder, uid, attachmentId);
    // Toujours un téléchargement, jamais un affichage : type neutre quel que soit le type déclaré par l'expéditeur.
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', attachmentDisposition(file.filename))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Length', file.content.length)
      .send(file.content);
  });

  // ── Actions sur un message ──

  app.post('/api/mail/accounts/:id/messages/:uid/flags', async (request) => {
    const { id, uid } = messageParams.parse(request.params);
    const { folder } = folderQuery.parse(request.query);
    const change = flagsBody.parse(request.body);
    const flags = await setFlags(getAccount(id), folder, uid, change);
    invalidateUnread(id);
    return { data: { uid, folder, ...flags } };
  });

  app.post('/api/mail/accounts/:id/messages/:uid/move', async (request) => {
    const { id, uid } = messageParams.parse(request.params);
    const { folder } = folderQuery.parse(request.query);
    const { destination } = moveBody.parse(request.body);
    const row = getAccount(id);
    await audited(request, { action: 'mail.message.move', target: messageTarget(row, folder, uid), details: { destination } }, () => moveMessage(row, folder, uid, destination));
    invalidateUnread(id);
    return { data: { moved: true, destination } };
  });

  app.delete('/api/mail/accounts/:id/messages/:uid', async (request) => {
    const { id, uid } = messageParams.parse(request.params);
    const { folder } = folderQuery.parse(request.query);
    const row = getAccount(id);
    const result = await audited(
      request,
      { action: 'mail.message.delete', target: messageTarget(row, folder, uid) },
      () => deleteMessage(row, folder, uid),
      (done) => ({ details: { movedToTrash: done.movedToTrash } }),
    );
    invalidateUnread(id);
    return { data: { deleted: true, movedToTrash: result.movedToTrash } };
  });

  // ── Envoi ──

  app.post('/api/mail/accounts/:id/send', { bodyLimit: LIMITS.sendBodyBytes }, async (request, reply): Promise<{ data: MailSendResult }> => {
    const { id } = accountParams.parse(request.params);
    const input = sendBody.parse(request.body);
    const row = getAccount(id);
    const user = currentUser(request);

    const retryAfter = takeSendSlot(user.id);
    if (retryAfter > 0) {
      audit(request, { action: 'mail.message.send', target: accountTarget(row), success: false, details: { error: 'RATE_LIMITED' } });
      reply.header('Retry-After', retryAfter);
      throw rateLimited('Trop de mails envoyés en peu de temps, réessayez plus tard');
    }

    const recipients = input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0);
    const details = { recipients, attachments: input.attachments?.length ?? 0, reply: input.inReplyTo !== undefined };

    const result = await audited(
      request,
      { action: 'mail.message.send', target: accountTarget(row), details },
      async () => {
        const original = input.inReplyTo ? await replyContext(row, input.inReplyTo.folder, input.inReplyTo.uid) : null;
        // L'expéditeur est l'adresse du compte désigné par l'URL : rien dans le corps de la requête ne peut le changer.
        const message = buildOutgoingMessage(row, input, original);
        const sent = await sendMessage(row, message);
        // Le mail est parti : la copie « Envoyés » et le marquage « répondu » sont faits au mieux.
        let raw: Buffer | null = null;
        if (!savesSentCopyItself(row)) {
          try {
            raw = await buildRawCopy(message);
          } catch {
            raw = null;
          }
        }
        const after = await afterSend(row, raw, input.inReplyTo ?? null);
        return { ...sent, ...after };
      },
      (done) => ({ details: { messageId: done.messageId, rejected: done.rejected, savedToSent: done.savedToSent, markedAnswered: done.markedAnswered } }),
    );
    return { data: { messageId: result.messageId } };
  });

  // ── Résumé des non-lus (interrogé périodiquement : ne prolonge pas la session) ──

  app.get('/api/mail/unread-summary', { config: { background: true } }, async (): Promise<{ data: MailUnreadSummary }> => {
    const rows = listAccounts();
    const entries = await Promise.all(rows.map((row) => unreadFor(row)));
    const accounts = rows.map((row, index) => ({
      accountId: row.id,
      label: row.label,
      address: row.address,
      unread: entries[index]!.unread,
      error: entries[index]!.error,
    }));
    return { data: { total: accounts.reduce((sum, account) => sum + account.unread, 0), accounts } };
  });
}
