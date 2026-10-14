import type { MailAccount, MailFolder, MailMessageDetail, MailMessageSummary, MailSendResult, MailUnreadSummary, PageMeta, WhmcsClientRef } from '@shared/api-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { securityAlert } from '../../core/alerts.js';
import { audit } from '../../core/audit.js';
import { AppError, rateLimited } from '../../core/errors.js';
import { currentUser } from '../../core/request.js';
import { findClientByEmail } from '../whmcs/service.js';
import {
  createAccount,
  deleteAccount,
  getAccessibleAccount,
  listAccessibleAccounts,
  recheckAccess,
  toMailAccount,
  updateAccount,
  visibilityOf,
  type BoundAccount,
  type MailAccountRow,
  type UpdateResult,
} from './accounts.js';
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

async function unreadFor(row: BoundAccount): Promise<UnreadEntry> {
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

type AlertSide = Pick<MailAccountRow, 'address' | 'owner_user_id'> | null;

/**
 * Texte de l'alerte de sécurité (envoyée aux DEUX administrateurs) pour un changement de compte. L'adresse d'une
 * boîte personnelle n'y figure jamais ; celle d'une boîte partagée (ou qui l'était juste avant) oui.
 */
export function accountAlertText(verb: 'ajouté' | 'modifié' | 'supprimé', username: string, before: AlertSide, after: AlertSide): { title: string; summary: string } {
  const wasShared = before !== null && visibilityOf(before) === 'shared';
  const isShared = after !== null && visibilityOf(after) === 'shared';
  if (before && after && wasShared && !isShared) {
    return {
      title: 'Compte mail partagé rendu personnel',
      summary: `Le compte de messagerie partagé ${before.address} a été rendu personnel par ${username} : il lui est désormais réservé et n'est plus accessible à l'autre administrateur.`,
    };
  }
  if (before && after && !wasShared && isShared) {
    return { title: 'Compte mail personnel rendu partagé', summary: `Le compte de messagerie ${after.address} a été rendu partagé par ${username}.` };
  }
  const shared = after ? isShared : wasShared;
  if (!shared) return { title: `Compte mail personnel ${verb}`, summary: `Un compte de messagerie personnel a été ${verb} par ${username}.` };
  const address = (after ?? before)?.address ?? '';
  return { title: `Compte mail ${verb}`, summary: `Le compte de messagerie partagé ${address} a été ${verb} par ${username}.` };
}

/**
 * Propriétaire si l'opération ne concerne QUE des boîtes personnelles (personnelle avant ET après : ajout, modification
 * ou suppression d'une boîte personnelle) ; null dès qu'une boîte partagée est en jeu (avant ou après).
 */
export function personalOnlyOwner(before: AlertSide, after: AlertSide): number | null {
  if (before === null && after === null) return null;
  if ((before !== null && before.owner_user_id === null) || (after !== null && after.owner_user_id === null)) return null;
  return (after ?? before)!.owner_user_id;
}

/**
 * Alerte de sécurité pour toute modification d'un compte de messagerie. Boîte partagée en jeu : les deux administrateurs.
 * Boîte personnelle uniquement : son seul propriétaire (mail et notification ciblés, sans Discord commun) — l'autre
 * administrateur n'apprend ainsi ni l'existence, ni le moment, ni l'auteur.
 */
function alertAccountChange(request: FastifyRequest, verb: 'ajouté' | 'modifié' | 'supprimé', before: AlertSide, after: AlertSide): void {
  const user = currentUser(request);
  const { title, summary } = accountAlertText(verb, user.username, before, after);
  const owner = personalOnlyOwner(before, after);
  securityAlert({
    ...(owner !== null ? { recipientUserId: owner } : {}),
    kind: 'settings_changed',
    severity: 'warning',
    title,
    summary,
    facts: [
      ['Adresse IP', request.client.ip],
      ['Navigateur', request.client.userAgent],
    ],
    userId: user.id,
  });
}

/**
 * Compte de l'URL, si l'administrateur connecté y a droit (partagé, ou personnel et à lui) ; sinon 404 identique à un
 * compte inexistant. TOUTES les routes /api/mail/accounts/:id/** passent par ici.
 */
const accessibleAccount = (request: FastifyRequest, id: number): BoundAccount => getAccessibleAccount(id, currentUser(request).id);

// ───────────────────────────── Routes ─────────────────────────────

export default async function mailRoutes(app: FastifyInstance): Promise<void> {
  // ── Comptes ──

  app.get('/api/mail/accounts', async (request): Promise<{ data: MailAccount[] }> => {
    const user = currentUser(request);
    return { data: listAccessibleAccounts(user.id).map((row) => toMailAccount(row, user.id)) };
  });

  app.post('/api/mail/accounts', { config: { stepUp: true } }, async (request, reply): Promise<{ data: MailAccount }> => {
    const input = accountCreateBody.parse(request.body);
    const user = currentUser(request);
    const row = await audited(
      request,
      {
        action: 'mail.account.create',
        target: null,
        details: { address: input.address, imapHost: input.imapHost, smtpHost: input.smtpHost, visibility: input.visibility },
      },
      () => createAccount(input, user.id),
      (created) => ({ target: accountTarget(created) }),
    );
    alertAccountChange(request, 'ajouté', null, row);
    reply.status(201);
    return { data: toMailAccount(row, user.id) };
  });

  app.put('/api/mail/accounts/:id', { config: { stepUp: true } }, async (request): Promise<{ data: MailAccount }> => {
    const { id } = accountParams.parse(request.params);
    const input = accountUpdateBody.parse(request.body);
    const user = currentUser(request);
    const before = accessibleAccount(request, id);
    const result: UpdateResult = await audited(
      request,
      { action: 'mail.account.update', target: accountTarget(before), details: { address: input.address, imapHost: input.imapHost, smtpHost: input.smtpHost } },
      () => updateAccount(id, input, user.id),
      (updated) => ({ details: { passwordChanged: updated.passwordChanged, visibility: visibilityOf(updated.row), visibilityChanged: updated.visibilityChange !== null } }),
    );
    invalidateUnread(id);
    alertAccountChange(request, 'modifié', result.before, result.row);
    return { data: toMailAccount(result.row, user.id) };
  });

  app.delete('/api/mail/accounts/:id', { config: { stepUp: true } }, async (request): Promise<{ data: { deleted: true } }> => {
    const { id } = accountParams.parse(request.params);
    const user = currentUser(request);
    const before = accessibleAccount(request, id);
    const deleted = await audited(request, { action: 'mail.account.delete', target: accountTarget(before), details: { address: before.address } }, () => deleteAccount(id, user.id));
    invalidateUnread(id);
    alertAccountChange(request, 'supprimé', deleted, null);
    return { data: { deleted: true } };
  });

  app.post('/api/mail/accounts/:id/test', async (request) => {
    const { id } = accountParams.parse(request.params);
    const row = accessibleAccount(request, id);
    const [imap, smtp] = await Promise.allSettled([testImap(row), testSmtp(row)]);
    const part = (name: string, outcome: PromiseSettledResult<void>) =>
      outcome.status === 'fulfilled' ? { ok: true, message: `${name} : connexion réussie` } : { ok: false, message: `${name} : ${toMailError(outcome.reason).message}` };
    recheckAccess(row); // droit revérifié avant de répondre
    const results = { imap: part('IMAP', imap), smtp: part('SMTP', smtp) };
    const ok = results.imap.ok && results.smtp.ok;
    audit(request, { action: 'mail.account.test', target: accountTarget(row), success: ok, details: { imap: results.imap.ok, smtp: results.smtp.ok } });
    return { data: { ok, message: ok ? 'Connexions IMAP et SMTP réussies' : `${results.imap.message} · ${results.smtp.message}`, ...results } };
  });

  // ── Lecture ──

  app.get('/api/mail/accounts/:id/folders', async (request): Promise<{ data: MailFolder[] }> => {
    const { id } = accountParams.parse(request.params);
    const account = accessibleAccount(request, id);
    const folders = await listFolders(account);
    recheckAccess(account); // droit revérifié avant de renvoyer des données
    return { data: folders };
  });

  app.get('/api/mail/accounts/:id/messages', async (request): Promise<{ data: MailMessageSummary[]; meta: PageMeta }> => {
    const { id } = accountParams.parse(request.params);
    const query = listQuery.parse(request.query);
    const account = accessibleAccount(request, id);
    const { messages, total } = await listMessages(account, query);
    recheckAccess(account);
    return { data: messages, meta: { page: query.page, pageSize: query.pageSize, total } };
  });

  app.get('/api/mail/accounts/:id/messages/:uid', async (request): Promise<{ data: MailMessageDetail }> => {
    const { id, uid } = messageParams.parse(request.params);
    const { folder } = folderQuery.parse(request.query);
    const account = accessibleAccount(request, id);
    const message = await readMessage(account, folder, uid);
    let whmcsClient: WhmcsClientRef | null = null;
    const sender = message.from?.address ?? '';
    if (isValidEmailAddress(sender)) {
      try {
        whmcsClient = await findClientByEmail(sender);
      } catch {
        whmcsClient = null;
      }
    }
    recheckAccess(account);
    return { data: { ...message, whmcsClient } };
  });

  app.get('/api/mail/accounts/:id/messages/:uid/attachments/:attachmentId', async (request, reply) => {
    const { id, uid, attachmentId } = attachmentParams.parse(request.params);
    const { folder } = folderQuery.parse(request.query);
    const account = accessibleAccount(request, id);
    const file = await downloadAttachment(account, folder, uid, attachmentId);
    recheckAccess(account);
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
    const account = accessibleAccount(request, id);
    const flags = await setFlags(account, folder, uid, change);
    invalidateUnread(id);
    recheckAccess(account);
    return { data: { uid, folder, ...flags } };
  });

  app.post('/api/mail/accounts/:id/messages/:uid/move', async (request) => {
    const { id, uid } = messageParams.parse(request.params);
    const { folder } = folderQuery.parse(request.query);
    const { destination } = moveBody.parse(request.body);
    const row = accessibleAccount(request, id);
    await audited(request, { action: 'mail.message.move', target: messageTarget(row, folder, uid), details: { destination } }, () => moveMessage(row, folder, uid, destination));
    invalidateUnread(id);
    recheckAccess(row);
    return { data: { moved: true, destination } };
  });

  app.delete('/api/mail/accounts/:id/messages/:uid', async (request) => {
    const { id, uid } = messageParams.parse(request.params);
    const { folder } = folderQuery.parse(request.query);
    const row = accessibleAccount(request, id);
    const result = await audited(
      request,
      { action: 'mail.message.delete', target: messageTarget(row, folder, uid) },
      () => deleteMessage(row, folder, uid),
      (done) => ({ details: { movedToTrash: done.movedToTrash } }),
    );
    invalidateUnread(id);
    recheckAccess(row);
    return { data: { deleted: true, movedToTrash: result.movedToTrash } };
  });

  // ── Envoi ──

  app.post('/api/mail/accounts/:id/send', { bodyLimit: LIMITS.sendBodyBytes }, async (request, reply): Promise<{ data: MailSendResult }> => {
    const { id } = accountParams.parse(request.params);
    const input = sendBody.parse(request.body);
    const row = accessibleAccount(request, id);
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
        // Après l'éventuelle lecture IMAP : droit revérifié, et la ligne RELUE (adresse à jour) compose le message.
        const current = recheckAccess(row);
        const message = buildOutgoingMessage(current, input, original);
        const sent = await sendMessage(current, message);
        // Le mail est parti : la copie « Envoyés » et le marquage « répondu » sont faits au mieux.
        let raw: Buffer | null = null;
        if (!savesSentCopyItself(row)) {
          try {
            raw = await buildRawCopy(message);
          } catch {
            raw = null;
          }
        }
        const after = await afterSend(current, raw, input.inReplyTo ?? null);
        return { ...sent, ...after };
      },
      (done) => ({ details: { messageId: done.messageId, rejected: done.rejected, savedToSent: done.savedToSent, markedAnswered: done.markedAnswered } }),
    );
    recheckAccess(row);
    return { data: { messageId: result.messageId } };
  });

  // ── Résumé des non-lus (interrogé périodiquement : ne prolonge pas la session) ──

  app.get('/api/mail/unread-summary', { config: { background: true } }, async (request): Promise<{ data: MailUnreadSummary }> => {
    // Uniquement les boîtes accessibles : le cache (par compte) n'est consulté qu'APRÈS ce filtrage.
    const rows = listAccessibleAccounts(currentUser(request).id);
    const entries = await Promise.all(rows.map((row) => unreadFor(row)));
    // Droits revérifiés après les connexions : une boîte devenue inaccessible entre-temps est retirée du résultat.
    const stillVisible = new Set(listAccessibleAccounts(currentUser(request).id).map((row) => row.id));
    const accounts = rows
      .map((row, index) => ({ row, entry: entries[index]! }))
      .filter(({ row }) => stillVisible.has(row.id))
      .map(({ row, entry }) => ({
      accountId: row.id,
      label: row.label,
      address: row.address,
      unread: entry.unread,
      error: entry.error,
    }));
    return { data: { total: accounts.reduce((sum, account) => sum + account.unread, 0), accounts } };
  });
}
