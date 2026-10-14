import { randomUUID } from 'node:crypto';
import type { AdminUser, SessionState } from '@shared/api-types';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { hmac, randomToken } from '../../core/crypto.js';
import { publish } from '../../core/events.js';
import { db } from '../../db/index.js';
import type { ClientInfo } from '../../types/fastify.js';
import { toAdminUser, type UserRow } from './users.js';

export interface SessionRow {
  id: string;
  token_hash: string;
  user_id: number;
  csrf_token: string;
  ip: string;
  country: string | null;
  user_agent: string;
  device_id: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  step_up_until: number | null;
  revoked_at: number | null;
}

/**
 * Noms des cookies. En production le préfixe « __Host- » impose Secure, Path=/ et l'absence de Domain ;
 * hors production (http://localhost) le préfixe et Secure sont retirés.
 */
const prefix = config.isProd ? '__Host-' : '';
export const SESSION_COOKIE = `${prefix}tc_session`;
export const CHALLENGE_COOKIE = `${prefix}tc_login`;
export const DEVICE_COOKIE = `${prefix}tc_device`;

const secureCookies = config.isProd || config.publicUrl.startsWith('https://');
export const cookieOptions = { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/' } as const;

/** Durée du cookie d'appareil (400 jours : plafond appliqué par les navigateurs). */
const DEVICE_COOKIE_MAX_AGE = 400 * 24 * 3600;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Un jeton opaque valide fait 32 octets en base64url ; toute autre valeur est ignorée sans requête SQL. */
export const isOpaqueToken = (value: unknown): value is string => typeof value === 'string' && TOKEN_PATTERN.test(value);

export const hashSessionToken = (token: string): string => hmac(token, 'session');
export const hashDeviceToken = (token: string): string => hmac(token, 'device');

/** Identifiant d'appareil (HMAC du cookie d'appareil) de la requête, ou null. */
export function deviceIdFromRequest(request: FastifyRequest): string | null {
  const token = request.cookies[DEVICE_COOKIE];
  return isOpaqueToken(token) ? hashDeviceToken(token) : null;
}

/** Pose un nouveau cookie d'appareil et retourne l'identifiant (HMAC) correspondant. */
export function issueDeviceCookie(reply: FastifyReply): string {
  const token = randomToken(32);
  reply.setCookie(DEVICE_COOKIE, token, { ...cookieOptions, maxAge: DEVICE_COOKIE_MAX_AGE });
  return hashDeviceToken(token);
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  // Cookie de session navigateur : l'expiration réelle (inactivité + absolue) est contrôlée côté serveur.
  reply.setCookie(SESSION_COOKIE, token, cookieOptions);
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, cookieOptions);
}

export interface NewSession {
  token: string;
  row: SessionRow;
}

/**
 * Ouvre une session. À n'appeler qu'après une authentification complète : le jeton (256 bits) est toujours
 * neuf (aucune fixation possible) et seul son HMAC est enregistré.
 */
export function createSession(userId: number, client: ClientInfo, deviceId: string | null, options: { stepUp?: boolean } = {}): NewSession {
  const now = Date.now();
  const token = randomToken(32);
  const row: SessionRow = {
    id: randomUUID(),
    token_hash: hashSessionToken(token),
    user_id: userId,
    csrf_token: randomToken(32),
    ip: client.ip,
    country: client.country,
    user_agent: client.userAgent.slice(0, 512),
    device_id: deviceId,
    created_at: now,
    last_seen_at: now,
    expires_at: now + config.sessionMaxMs,
    step_up_until: options.stepUp ? now + config.stepUpMs : null,
    revoked_at: null,
  };
  db.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, csrf_token, ip, country, user_agent, device_id, created_at, last_seen_at, expires_at, step_up_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.token_hash, row.user_id, row.csrf_token, row.ip, row.country, row.user_agent, row.device_id, row.created_at, row.last_seen_at, row.expires_at, row.step_up_until);
  return { token, row };
}

export const isSessionActive = (row: SessionRow, now: number): boolean =>
  row.revoked_at === null && row.expires_at > now && row.last_seen_at + config.sessionIdleMs > now;

/** Session valide (non révoquée, ni expirée par inactivité, ni expirée en absolu) correspondant au jeton, ou null. */
export function resolveSession(token: unknown, now: number): { row: SessionRow; user: UserRow } | null {
  if (!isOpaqueToken(token)) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashSessionToken(token)) as SessionRow | undefined;
  if (!row || !isSessionActive(row, now)) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as UserRow | undefined;
  return user ? { row, user } : null;
}

export function touchSession(row: SessionRow, now: number): void {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, row.id);
  row.last_seen_at = now;
}

export function grantStepUp(row: SessionRow, now: number): number {
  const until = now + config.stepUpMs;
  db.prepare('UPDATE sessions SET step_up_until = ? WHERE id = ?').run(until, row.id);
  row.step_up_until = until;
  return until;
}

export function activeSessions(userId: number, now: number): SessionRow[] {
  return db
    .prepare('SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at > ? ORDER BY last_seen_at DESC')
    .all(userId, now, now - config.sessionIdleMs) as SessionRow[];
}

/** Révoque une session du compte. Retourne false si elle n'existe pas (ou appartient à l'autre compte). */
export function revokeSession(userId: number, sessionId: string): boolean {
  const changed = db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(Date.now(), sessionId, userId).changes;
  if (changed) publish({ event: { type: 'session_revoked' }, userId, sessionId });
  return changed === 1;
}

/** Révoque toutes les sessions du compte (sauf `exceptSessionId`). Retourne le nombre de sessions révoquées. */
export function revokeUserSessions(userId: number, exceptSessionId: string | null = null): number {
  const now = Date.now();
  const rows = db.prepare('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?').all(userId, exceptSessionId) as { id: string }[];
  const revoke = db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL');
  let count = 0;
  for (const { id } of rows) {
    if (revoke.run(now, id).changes) {
      count += 1;
      publish({ event: { type: 'session_revoked' }, userId, sessionId: id });
    }
  }
  return count;
}

export function sessionState(row: SessionRow, user: AdminUser | UserRow): SessionState {
  return {
    authenticated: true,
    user: 'password_hash' in user ? toAdminUser(user) : user,
    csrfToken: row.csrf_token,
    stepUpUntil: row.step_up_until && row.step_up_until > Date.now() ? new Date(row.step_up_until).toISOString() : null,
    idleTimeoutSeconds: Math.round(config.sessionIdleMs / 1000),
    expiresAt: new Date(row.expires_at).toISOString(),
    pendingLogin: null,
  };
}

// Session de la requête en cours (posée par le plugin de sécurité) : évite une seconde lecture en base.
const requestSessions = new WeakMap<FastifyRequest, SessionRow>();
export const bindRequestSession = (request: FastifyRequest, row: SessionRow): void => void requestSessions.set(request, row);
export const requestSession = (request: FastifyRequest): SessionRow | null => requestSessions.get(request) ?? null;

/**
 * Relit en base la session de la requête : vrai si elle est toujours valide. À appeler après toute attente
 * (`await`) avant de modifier un état : la session a pu être révoquée ou le compte verrouillé entre-temps.
 */
export function refreshRequestSession(request: FastifyRequest): SessionRow | null {
  const bound = requestSessions.get(request);
  if (!bound) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(bound.id) as SessionRow | undefined;
  if (!row || !isSessionActive(row, Date.now())) return null;
  requestSessions.set(request, row);
  return row;
}

/** Ménage : sessions et challenges expirés, anciens échecs. Les sessions closes sont gardées 30 jours (traçabilité). */
export function purgeExpired(now = Date.now()): void {
  const keep = now - 30 * 24 * 3600_000;
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').run(keep, keep);
  db.prepare('DELETE FROM login_challenges WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM auth_failures WHERE at < ?').run(now - 24 * 3600_000);
  db.prepare('DELETE FROM auth_ip_blocks WHERE blocked_until < ?').run(now - 24 * 3600_000);
}
