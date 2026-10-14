import type { AuditEntry, BackupCodes, BackupCodesStatus, IpAllowlist, KnownDevice, PageMeta, SessionInfo, TotpSetup } from '@shared/api-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { securityAlert } from '../../core/alerts.js';
import { audit } from '../../core/audit.js';
import { accountLocked, badRequest, notFound, stepUpRequired, unauthenticated } from '../../core/errors.js';
import { db } from '../../db/index.js';
import { regenerateBackupCodes, setPassword } from './admin.js';
import { backupCodesStatus } from './backup-codes.js';
import { deviceLabel } from './device.js';
import { envAllowlist, getPanelAllowlist, MAX_ALLOWLIST_ENTRIES, normalizeAllowlistEntry, setPanelAllowlist, wouldAllow } from './ip-allowlist.js';
import { clientFacts, lockRemainingSeconds } from './lockout.js';
import { PASSWORD_MAX_LENGTH, verifyPassword } from './passwords.js';
import { sessionAuthFailure } from './session-guard.js';
import { serialized } from './serialize.js';
import { activeSessions, clearSessionCookie, refreshRequestSession, requestSession, revokeSession, revokeUserSessions } from './sessions.js';
import { decryptPendingTotpSecret, encryptPendingTotpSecret, encryptTotpSecret, matchTotpStep, newTotpSecret, totpUri } from './totp.js';
import { findUserById, type UserRow } from './users.js';

/** Un nouveau secret TOTP non confirmé expire après ce délai. */
const TOTP_PENDING_TTL_MS = 15 * 60_000;

const iso = (ms: number): string => new Date(ms).toISOString();

/** Compte de la requête, relu en base (les routes de ce fichier exigent toutes une session). */
function account(request: FastifyRequest): UserRow {
  const user = request.auth ? findUserById(request.auth.user.id) : null;
  if (!request.auth || !user) throw unauthenticated();
  return user;
}

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const auditQuerySchema = pageSchema.extend({
  action: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.-]{1,80}$/)
    .optional(),
  success: z.enum(['true', 'false', '1', '0']).optional(),
});

const sessionIdSchema = z.object({ id: z.uuid() });
const numericIdSchema = z.object({ id: z.coerce.number().int().positive() });
const allowlistSchema = z.object({ entries: z.array(z.string().trim().min(1).max(64)).max(MAX_ALLOWLIST_ENTRIES) });
const passwordSchema = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH) });
const totpConfirmSchema = z.object({
  code: z
    .string()
    .max(32)
    .transform((value) => value.replace(/\s+/g, ''))
    .pipe(z.string().regex(/^\d{6}$/, 'Code à 6 chiffres attendu')),
});

interface AuditRow {
  id: number;
  at: number;
  action: string;
  target: string | null;
  success: number;
  ip: string | null;
  country: string | null;
  user_agent: string | null;
  details: string | null;
}

function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export default async function securityRoutes(app: FastifyInstance): Promise<void> {
  // ── Sessions ──
  app.get('/api/security/sessions', async (request): Promise<{ data: SessionInfo[] }> => {
    const user = account(request);
    const data = activeSessions(user.id, Date.now()).map(
      (row): SessionInfo => ({
        id: row.id,
        current: row.id === request.auth?.sessionId,
        ip: row.ip,
        country: row.country,
        userAgent: row.user_agent,
        deviceLabel: deviceLabel(row.user_agent),
        createdAt: iso(row.created_at),
        lastSeenAt: iso(row.last_seen_at),
        expiresAt: iso(row.expires_at),
      }),
    );
    return { data };
  });

  app.delete('/api/security/sessions/:id', async (request, reply) => {
    const user = account(request);
    const { id } = sessionIdSchema.parse(request.params);
    const current = id === request.auth?.sessionId;
    // Journalisé avant la révocation : l'entrée porte encore l'identifiant de la session appelante.
    if (!revokeSession(user.id, id)) {
      audit(request, { action: 'security.session.revoke', target: `session ${id}`, success: false });
      throw notFound('Session introuvable');
    }
    audit(request, { action: 'security.session.revoke', target: `session ${id}`, details: { current } });
    if (current) clearSessionCookie(reply);
    return { data: { ok: true } };
  });

  app.post('/api/security/sessions/revoke-others', async (request) => {
    const user = account(request);
    const revoked = revokeUserSessions(user.id, request.auth?.sessionId ?? null);
    audit(request, { action: 'security.session.revoke_others', details: { revoked } });
    return { data: { revoked } };
  });

  // ── Journal : celui du compte connecté + les évènements non attribués, jamais celui de l'autre compte ──
  app.get('/api/security/audit', async (request): Promise<{ data: AuditEntry[]; meta: PageMeta }> => {
    const user = account(request);
    const query = auditQuerySchema.parse(request.query);

    const where = ['(user_id = ? OR user_id IS NULL)'];
    const params: (string | number)[] = [user.id];
    if (query.action) {
      where.push("action LIKE ? ESCAPE '\\'");
      params.push(`${query.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (query.success) {
      where.push('success = ?');
      params.push(query.success === 'true' || query.success === '1' ? 1 : 0);
    }
    const clause = where.join(' AND ');

    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM audit_log WHERE ${clause}`).get(...params) as { total: number };
    const rows = db
      .prepare(`SELECT id, at, action, target, success, ip, country, user_agent, details FROM audit_log WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as AuditRow[];

    return {
      data: rows.map(
        (row): AuditEntry => ({
          id: row.id,
          at: iso(row.at),
          action: row.action,
          target: row.target,
          success: row.success === 1,
          ip: row.ip,
          country: row.country,
          userAgent: row.user_agent,
          deviceLabel: row.user_agent ? deviceLabel(row.user_agent) : null,
          details: parseDetails(row.details),
        }),
      ),
      meta: { page: query.page, pageSize: query.pageSize, total },
    };
  });

  // ── Appareils connus ──
  app.get('/api/security/devices', async (request): Promise<{ data: KnownDevice[] }> => {
    const user = account(request);
    const rows = db.prepare('SELECT id, device_hash, label, last_ip, first_seen_at, last_seen_at FROM known_devices WHERE user_id = ? ORDER BY last_seen_at DESC').all(user.id) as {
      id: number;
      device_hash: string;
      label: string;
      last_ip: string | null;
      first_seen_at: number;
      last_seen_at: number;
    }[];
    const session = requestSession(request);
    return {
      data: rows.map((row) => ({
        id: row.id,
        label: row.label,
        firstSeenAt: iso(row.first_seen_at),
        lastSeenAt: iso(row.last_seen_at),
        lastIp: row.last_ip,
        current: row.device_hash === (session?.device_id ?? request.client.deviceId),
      })),
    };
  });

  app.delete('/api/security/devices/:id', async (request) => {
    const user = account(request);
    const { id } = numericIdSchema.parse(request.params);
    const device = db.prepare('SELECT device_hash, label FROM known_devices WHERE id = ? AND user_id = ?').get(id, user.id) as { device_hash: string; label: string } | undefined;
    if (!device) {
      audit(request, { action: 'security.device.forget', target: `appareil #${id}`, success: false });
      throw notFound('Appareil introuvable');
    }
    const currentSessionId = request.auth?.sessionId ?? null;
    const revoked = db.transaction(() => {
      db.prepare('DELETE FROM known_devices WHERE id = ? AND user_id = ?').run(id, user.id);
      // Les autres sessions ouvertes depuis cet appareil sont fermées ; il devra être reconfirmé par mail.
      const sessions = db.prepare('SELECT id FROM sessions WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL AND id IS NOT ?').all(user.id, device.device_hash, currentSessionId) as { id: string }[];
      return sessions.map((s) => s.id);
    })();
    for (const sessionId of revoked) revokeSession(user.id, sessionId);
    audit(request, { action: 'security.device.forget', target: `appareil #${id} (${device.label})`, details: { revokedSessions: revoked.length } });
    return { data: { ok: true } };
  });

  // ── Liste blanche d'IP ──
  const allowlistView = (request: FastifyRequest): IpAllowlist => ({ entries: getPanelAllowlist(), envEntries: [...envAllowlist], currentIp: request.client.ip });

  app.get('/api/security/ip-allowlist', async (request): Promise<{ data: IpAllowlist }> => {
    account(request);
    return { data: allowlistView(request) };
  });

  app.put('/api/security/ip-allowlist', { config: { stepUp: true } }, async (request): Promise<{ data: IpAllowlist }> => {
    const user = account(request);
    const body = allowlistSchema.parse(request.body);

    const invalid: string[] = [];
    const entries: string[] = [];
    for (const raw of body.entries) {
      const normalized = normalizeAllowlistEntry(raw);
      if (!normalized) invalid.push(raw);
      else if (!entries.includes(normalized)) entries.push(normalized);
    }
    if (invalid.length) {
      audit(request, { action: 'security.ip_allowlist.update', success: false, details: { reason: 'invalid_entries' } });
      throw badRequest('Entrées invalides : chaque entrée doit être une adresse IP ou un bloc CIDR', { invalid });
    }
    // Anti-enfermement : la nouvelle liste ne doit pas exclure l'appelant.
    if (!wouldAllow(request.client.ip, entries)) {
      audit(request, { action: 'security.ip_allowlist.update', success: false, details: { reason: 'would_lock_out_caller' } });
      throw badRequest(`Cette liste exclurait votre adresse IP actuelle (${request.client.ip}) : ajoutez-la avant d'enregistrer`, { currentIp: request.client.ip });
    }

    const previous = getPanelAllowlist();
    setPanelAllowlist(entries, user.id);
    audit(request, { action: 'security.ip_allowlist.update', details: { previous, entries } });
    securityAlert({
      kind: 'ip_allowlist_changed',
      severity: 'warning',
      title: "Liste blanche d'IP modifiée",
      summary: `Le compte ${user.username} a modifié la liste blanche d'IP du panel.`,
      facts: [['Compte', user.username], ['Nouvelle liste', entries.length ? entries.join(', ') : '(vide : filtrage du panel désactivé)'], ...clientFacts(request.client)],
      userId: user.id,
    });
    return { data: allowlistView(request) };
  });

  // ── Mot de passe ──
  app.post('/api/security/password', { config: { stepUp: true } }, async (request, reply) => {
    const caller = account(request);
    const body = passwordSchema.parse(request.body);

    /**
     * État courant du compte, relu en base. Lève une erreur si la session n'est plus valide, si le compte est
     * verrouillé ou si le mot de passe a changé depuis `expectedHash`. Rappelé après CHAQUE attente : une
     * tentative « en vol » pendant qu'un verrouillage survient n'est jamais acceptée.
     */
    const current = (expectedHash?: string): UserRow => {
      const fresh = findUserById(caller.id);
      if (!fresh || !refreshRequestSession(request)) {
        clearSessionCookie(reply);
        throw unauthenticated();
      }
      const locked = lockRemainingSeconds(fresh);
      if (locked > 0) throw accountLocked(locked);
      if (expectedHash !== undefined && fresh.password_hash !== expectedHash) throw badRequest('Le mot de passe a été modifié entre-temps : recommencez');
      return fresh;
    };

    // Les tentatives d'un même compte passent une par une : chacune voit les échecs comptés par la précédente.
    const user = await serialized(`secret:${caller.id}`, async () => {
      const before = current();
      const currentOk = await verifyPassword(before.password_hash, body.currentPassword);
      const after = current(before.password_hash);
      if (!currentOk) throw sessionAuthFailure(request, reply, after, 'current_password', 'Mot de passe actuel incorrect');

      if (body.newPassword === body.currentPassword) throw badRequest("Le nouveau mot de passe doit être différent de l'actuel");
      const problems = await setPassword(after, body.newPassword, () => void current(before.password_hash));
      if (problems.length) {
        audit(request, { action: 'security.password.change', success: false, details: { reason: 'weak_password' } });
        throw badRequest(`Mot de passe refusé : ${problems.join(', ')}`, { problems });
      }
      return after;
    });

    const revoked = revokeUserSessions(user.id, request.auth?.sessionId ?? null);
    audit(request, { action: 'security.password.change', details: { revokedSessions: revoked } });
    securityAlert({
      kind: 'password_changed',
      severity: 'critical',
      title: `Mot de passe modifié : ${user.username}`,
      summary: `Le mot de passe du compte ${user.username} vient d'être modifié. Ses autres sessions ont été fermées.`,
      facts: [['Compte', user.username], ...clientFacts(request.client)],
      userId: user.id,
    });
    return { data: { ok: true } };
  });

  // ── TOTP : nouveau secret en attente, activé seulement après confirmation par un code ──
  app.post('/api/security/totp/regenerate', { config: { stepUp: true } }, async (request): Promise<{ data: TotpSetup }> => {
    const user = account(request);
    const secret = newTotpSecret();
    const otpauthUrl = totpUri(user.username, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 2, width: 256 });
    // Après l'attente : la session doit toujours être valide et la fenêtre de step-up toujours ouverte.
    const session = refreshRequestSession(request);
    if (!session) throw unauthenticated();
    if (!session.step_up_until || session.step_up_until <= Date.now()) throw stepUpRequired();
    db.prepare('UPDATE users SET totp_pending_enc = ?, totp_pending_at = ? WHERE id = ?').run(encryptPendingTotpSecret(user.id, secret), Date.now(), user.id);
    audit(request, { action: 'security.totp.regenerate' });
    return { data: { secret, otpauthUrl, qrDataUrl } };
  });

  app.post('/api/security/totp/confirm', async (request, reply) => {
    const user = account(request);
    const body = totpConfirmSchema.parse(request.body);

    const locked = lockRemainingSeconds(user);
    if (locked > 0) throw accountLocked(locked);

    const now = Date.now();
    if (!user.totp_pending_enc || !user.totp_pending_at || user.totp_pending_at + TOTP_PENDING_TTL_MS <= now) {
      db.prepare('UPDATE users SET totp_pending_enc = NULL, totp_pending_at = NULL WHERE id = ?').run(user.id);
      audit(request, { action: 'security.totp.confirm', success: false, details: { reason: 'no_pending_secret' } });
      throw badRequest('Aucun nouveau secret 2FA en attente (ou délai dépassé) : relancez la régénération');
    }

    const secret = decryptPendingTotpSecret(user.id, user.totp_pending_enc);
    const step = matchTotpStep(secret, body.code, 0);
    if (step === null) throw sessionAuthFailure(request, reply, user, 'totp_confirm', 'Code 2FA incorrect');

    // Activation atomique : seulement si le secret en attente est toujours celui qui vient d'être vérifié.
    const activated = db
      .prepare('UPDATE users SET totp_secret_enc = ?, totp_pending_enc = NULL, totp_pending_at = NULL, totp_last_step = ? WHERE id = ? AND totp_pending_enc = ?')
      .run(encryptTotpSecret(user.id, secret), step, user.id, user.totp_pending_enc).changes;
    if (activated !== 1) throw badRequest('Le secret en attente a changé : relancez la régénération');

    const revoked = revokeUserSessions(user.id, request.auth?.sessionId ?? null);
    audit(request, { action: 'security.totp.confirm', details: { revokedSessions: revoked } });
    securityAlert({
      kind: 'totp_changed',
      severity: 'critical',
      title: `Double authentification modifiée : ${user.username}`,
      summary: `Le secret 2FA (TOTP) du compte ${user.username} vient d'être remplacé. Ses autres sessions ont été fermées.`,
      facts: [['Compte', user.username], ...clientFacts(request.client)],
      userId: user.id,
    });
    return { data: { ok: true } };
  });

  // ── Codes de secours ──
  app.get('/api/security/backup-codes', async (request): Promise<{ data: BackupCodesStatus }> => {
    return { data: backupCodesStatus(account(request).id) };
  });

  app.post('/api/security/backup-codes/regenerate', { config: { stepUp: true } }, async (request): Promise<{ data: BackupCodes }> => {
    const user = account(request);
    const codes = regenerateBackupCodes(user.id);
    audit(request, { action: 'security.backup_codes.regenerate' });
    securityAlert({
      kind: 'backup_codes_regenerated',
      severity: 'warning',
      title: `Codes de secours régénérés : ${user.username}`,
      summary: `Les codes de secours 2FA du compte ${user.username} viennent d'être régénérés. Les anciens ne sont plus valables.`,
      facts: [['Compte', user.username], ...clientFacts(request.client)],
      userId: user.id,
    });
    return { data: { codes } };
  });
}
