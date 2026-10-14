import type { LoginStepResponse, NewContextReason, SessionState, StepUpResponse } from '@shared/api-types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { securityAlert } from '../../core/alerts.js';
import { audit } from '../../core/audit.js';
import { hmac, randomDigits, randomToken, safeEqual, sha256 } from '../../core/crypto.js';
import { AppError, accountLocked, badRequest, invalidCredentials, rateLimited, unauthenticated } from '../../core/errors.js';
import { db } from '../../db/index.js';
import { removePushForDevice } from '../notifications/push.js';
import { backupCodesStatus, consumeBackupCode, findBackupCode } from './backup-codes.js';
import { deviceLabel } from './device.js';
import {
  clearAccountFailures,
  clearFailedAttempts,
  clientFacts,
  isKnownDevice,
  lockRemainingSeconds,
  recordAuthFailure,
  unknownDeviceLockRemainingSeconds,
  type FailureKind,
} from './lockout.js';
import { serialized } from './serialize.js';
import { sessionAuthFailure } from './session-guard.js';
import { REASON_LABELS, sendDeviceCodeMail, sendLoginCodeMail } from './mails.js';
import { verifyDummyPassword, verifyPassword } from './passwords.js';
import {
  CHALLENGE_COOKIE,
  clearSessionCookie,
  cookieOptions,
  createSession,
  deviceIdFromRequest,
  grantStepUp,
  isOpaqueToken,
  issueDeviceCookie,
  requestSession,
  revokeSession,
  sessionState,
  setSessionCookie,
} from './sessions.js';
import { commitTotpStep, decryptTotpSecret, matchTotpStep } from './totp.js';
import { emailHint, findUserById, findUserByIdentifier, toAdminUser, type UserRow } from './users.js';

const CHALLENGE_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 10 * 60_000;
/** Essais par étape (second facteur, puis confirmation d'appareil) avant destruction du challenge. */
const MAX_CHALLENGE_ATTEMPTS = 5;
/** Mails par étape : l'envoi initial + 2 renvois. */
const MAX_EMAILS_PER_STAGE = 3;
/** Connexions en cours simultanées par compte. */
const MAX_PENDING_CHALLENGES = 5;

interface ChallengeRow {
  id: number;
  token_hash: string;
  user_id: number;
  stage: 'second_factor' | 'device_confirmation';
  email_code_hash: string | null;
  email_code_expires_at: number | null;
  device_code_hash: string | null;
  device_code_expires_at: number | null;
  attempts: number;
  emails_sent: number;
  reasons: string | null;
  ip: string;
  country: string | null;
  user_agent: string;
  device_id: string | null;
  second_factor_method: string | null;
  created_at: number;
  expires_at: number;
}

const hashChallengeToken = (token: string): string => hmac(token, 'login-challenge');
const hashEmailCode = (challenge: Pick<ChallengeRow, 'token_hash'>, code: string): string => hmac(code, `email-code:${challenge.token_hash}`);
const hashDeviceCode = (challenge: Pick<ChallengeRow, 'token_hash'>, code: string): string => hmac(code, `device-code:${challenge.token_hash}`);

const digits = (length: number) =>
  z
    .string()
    .max(32)
    .transform((value) => value.replace(/[\s-]+/g, ''))
    .pipe(z.string().regex(new RegExp(`^\\d{${length}}$`), `Code à ${length} chiffres attendu`));

const optionalText = (schema: z.ZodType<string>) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : (value ?? undefined)), schema.optional());

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(1024),
});

const verifySchema = z
  .object({
    emailCode: digits(6),
    totpCode: optionalText(digits(6)),
    backupCode: optionalText(z.string().max(64)),
  })
  .refine((body) => (body.totpCode === undefined) !== (body.backupCode === undefined), {
    message: 'Fournissez soit le code 2FA, soit un code de secours',
    path: ['totpCode'],
  });

const confirmDeviceSchema = z.object({ code: digits(8) });
const stepUpSchema = z.object({ totpCode: digits(6) });

/** Erreur générique de connexion ; `restart` indique au frontend de revenir à la première étape. */
const loginExpired = () => new AppError(401, 'INVALID_CREDENTIALS', 'Connexion expirée ou invalide, recommencez', { restart: true });
const invalidCodes = (restart: boolean) =>
  restart ? new AppError(401, 'INVALID_CREDENTIALS', 'Identifiants ou codes incorrects. Trop d’essais : recommencez la connexion', { restart: true }) : invalidCredentials();

function parseReasons(raw: string | null): NewContextReason[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((r): r is NewContextReason => r === 'new_device' || r === 'new_ip' || r === 'new_country') : [];
  } catch {
    return [];
  }
}

function loadChallenge(request: FastifyRequest): ChallengeRow | null {
  const token = request.cookies[CHALLENGE_COOKIE];
  if (!isOpaqueToken(token)) return null;
  const row = db.prepare('SELECT * FROM login_challenges WHERE token_hash = ?').get(hashChallengeToken(token)) as ChallengeRow | undefined;
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    db.prepare('DELETE FROM login_challenges WHERE id = ?').run(row.id);
    return null;
  }
  return row;
}

function destroyChallenge(reply: FastifyReply, challenge: ChallengeRow | null): void {
  if (challenge) db.prepare('DELETE FROM login_challenges WHERE id = ?').run(challenge.id);
  reply.clearCookie(CHALLENGE_COOKIE, cookieOptions);
}

/** Compte un essai de façon atomique. false = plus d'essai disponible. */
function takeAttempt(challenge: ChallengeRow): boolean {
  return db.prepare('UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ? AND attempts < ?').run(challenge.id, MAX_CHALLENGE_ATTEMPTS).changes === 1;
}

function mailFailure(request: FastifyRequest, user: UserRow, err: unknown): AppError {
  request.log.error({ err }, 'auth: envoi du code par mail impossible');
  audit(request, { action: 'auth.login.mail_failure', target: `compte ${user.username}`, success: false, userId: user.id });
  return new AppError(502, 'UPSTREAM_ERROR', "Impossible d'envoyer le code par mail, réessayez plus tard", { integration: 'mail' });
}

/**
 * Échec à une étape protégée par un challenge : compte l'échec, détruit le challenge s'il n'a plus d'essai
 * ou si le compte vient d'être verrouillé, puis retourne l'erreur à lever.
 */
function challengeFailure(request: FastifyRequest, reply: FastifyReply, user: UserRow, challenge: ChallengeRow, kind: FailureKind, details: Record<string, unknown>): AppError {
  const { lockedUntil } = recordAuthFailure(request, { user, kind, details });
  const left = db.prepare('SELECT attempts FROM login_challenges WHERE id = ?').get(challenge.id) as { attempts: number } | undefined;
  const exhausted = !left || left.attempts >= MAX_CHALLENGE_ATTEMPTS;
  if (lockedUntil !== null) {
    destroyChallenge(reply, challenge);
    // Le détenteur du challenge a déjà prouvé le mot de passe : annoncer le verrouillage ne révèle rien de plus.
    return accountLocked(Math.ceil((lockedUntil - Date.now()) / 1000));
  }
  if (exhausted) destroyChallenge(reply, challenge);
  return invalidCodes(exhausted);
}

/** Ouvre la session après authentification complète (les deux facteurs, et la confirmation d'appareil si exigée). */
function finishLogin(request: FastifyRequest, reply: FastifyReply, user: UserRow, challenge: ChallengeRow, context: { reasons: NewContextReason[]; method: 'totp' | 'backup_code' }): LoginStepResponse {
  const now = Date.now();
  const client = { ...request.client, deviceId: challenge.device_id };

  const session = db.transaction(() => {
    const created = createSession(user.id, client, challenge.device_id, { stepUp: true });
    if (challenge.device_id) {
      db.prepare(
        `INSERT INTO known_devices (user_id, device_hash, label, last_ip, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, device_hash) DO UPDATE SET label = excluded.label, last_ip = excluded.last_ip, last_seen_at = excluded.last_seen_at`,
      ).run(user.id, challenge.device_id, deviceLabel(client.userAgent), client.ip, now, now);
    }
    db.prepare(
      `INSERT INTO known_ips (user_id, ip, country, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, ip) DO UPDATE SET country = COALESCE(excluded.country, country), last_seen_at = excluded.last_seen_at`,
    ).run(user.id, client.ip, client.country, now, now);
    // Cette connexion vient de confirmer un nouvel appareil : le verrou « appareils inconnus » est levé aussi.
    clearAccountFailures(user.id, { unknownDevices: context.reasons.includes('new_device') });
    db.prepare('DELETE FROM login_challenges WHERE user_id = ?').run(user.id);
    return created;
  })();

  reply.clearCookie(CHALLENGE_COOKIE, cookieOptions);
  setSessionCookie(reply, session.token);
  request.client = client;
  request.auth = { user: toAdminUser(user), sessionId: session.row.id, stepUpUntil: session.row.step_up_until };

  audit(request, { action: 'auth.login.success', target: `compte ${user.username}`, details: { method: context.method, newContext: context.reasons } });
  securityAlert({
    kind: 'login_success',
    severity: context.reasons.length ? 'warning' : 'info',
    title: `Connexion au panel : ${user.username}`,
    summary: `Le compte ${user.username} vient de se connecter à TalCloud Panel.`,
    facts: [
      ['Compte', user.username],
      ...clientFacts(client),
      ['Second facteur', context.method === 'backup_code' ? `code de secours (${backupCodesStatus(user.id).remaining} restants)` : 'code 2FA'],
      ['Contexte inhabituel', context.reasons.length ? context.reasons.map((r) => REASON_LABELS[r]).join(', ') : 'non'],
    ],
    userId: user.id,
  });

  return { step: 'done', session: sessionState(session.row, user) };
}

export default async function loginRoutes(app: FastifyInstance): Promise<void> {
  // ── État de session : publique, toujours 200 ──
  app.get('/api/auth/session', { config: { public: true } }, async (request): Promise<{ data: SessionState }> => {
    const session = requestSession(request);
    if (request.auth && session) return { data: sessionState(session, request.auth.user) };

    const challenge = loadChallenge(request);
    const user = challenge ? findUserById(challenge.user_id) : null;
    if (challenge && user) {
      const reasons = parseReasons(challenge.reasons);
      return {
        data: {
          authenticated: false,
          pendingLogin: { step: challenge.stage, emailHint: emailHint(user.email), ...(challenge.stage === 'device_confirmation' ? { reasons } : {}) },
        },
      };
    }
    return { data: { authenticated: false, pendingLogin: null } };
  });

  // ── Étape 1 : mot de passe ──
  app.post('/api/auth/login', { config: { public: true } }, async (request, reply): Promise<{ data: LoginStepResponse }> => {
    const body = loginSchema.parse(request.body);

    // Les tentatives passent une par une : chacune voit les échecs et verrous laissés par la précédente.
    // La file est choisie AVANT d'attendre, par deux lectures SQL bon marché (même coût que l'appareil soit
    // inconnu, le compte existant ou non) :
    //  - appareil déjà confirmé par ce compte → file propre à cet appareil : un flot anonyme qui sature la file
    //    plafonnée du compte ne peut pas empêcher le titulaire de se connecter depuis son appareil connu ;
    //  - appareil inconnu → une file plafonnée commune au compte (nom d'utilisateur et e-mail confondus), ou une
    //    file par identifiant s'il ne correspond à aucun compte.
    const target = findUserByIdentifier(body.identifier);
    const requestDevice = deviceIdFromRequest(request);
    const queue = !target
      ? `login:inconnu:${sha256(body.identifier.trim().toLowerCase())}`
      : requestDevice && isKnownDevice(target.id, requestDevice)
        ? `login:${target.id}:known:${requestDevice}`
        : `login:${target.id}:unknown`;
    const user = await serialized(queue, async (): Promise<UserRow> => {
      const found = findUserByIdentifier(body.identifier);
      // Toujours une vérification Argon2id, même si le compte n'existe pas (temps de réponse équivalent).
      const passwordOk = found ? await verifyPassword(found.password_hash, body.password) : await verifyDummyPassword(body.password);
      // Relecture APRÈS l'attente : verrous, mot de passe et appareils ont pu changer entre-temps.
      const fresh = found ? findUserById(found.id) : null;
      if (!fresh || !found) {
        recordAuthFailure(request, { user: null, kind: 'password' });
        throw invalidCredentials();
      }
      const stillValid = passwordOk && fresh.password_hash === found.password_hash;
      const accountLockedFor = lockRemainingSeconds(fresh);

      if (!isKnownDevice(fresh.id, deviceIdFromRequest(request))) {
        // Appareil inconnu. Pendant le verrou « appareils inconnus » (ou le verrou complet), la réponse est la même
        // que le mot de passe soit bon ou non : ni challenge, ni 423 — aucun oracle pour qui devine le mot de passe.
        const blocked = unknownDeviceLockRemainingSeconds(fresh) > 0 || accountLockedFor > 0;
        if (blocked || !stillValid) {
          recordAuthFailure(request, { user: fresh, kind: 'password', scope: 'unknown_device', details: blocked ? { duringLock: true, passwordValid: stillValid } : undefined });
          if (blocked && stillValid) {
            securityAlert({
              kind: 'suspicious_activity',
              severity: 'critical',
              title: `Mot de passe correct présenté pendant un blocage : ${fresh.username}`,
              summary: `Pendant un blocage du compte ${fresh.username}, le bon mot de passe a été présenté depuis un appareil inconnu et la connexion a été refusée. Si ce n'était pas vous, votre mot de passe est compromis : changez-le depuis un appareil connu.`,
              facts: [['Compte', fresh.username], ...clientFacts(request.client)],
              userId: fresh.id,
              throttleKey: `mot-de-passe-pendant-blocage:${fresh.id}`,
            });
          }
          throw invalidCredentials();
        }
        return fresh;
      }

      // Appareil déjà confirmé par ce compte : le verrou « appareils inconnus » ne s'applique pas.
      if (!stillValid) {
        recordAuthFailure(request, { user: fresh, kind: 'password', scope: 'account' });
        throw invalidCredentials();
      }
      // Verrou complet : annoncé (423) uniquement ici — bon mot de passe ET appareil connu —, jamais à un inconnu.
      if (accountLockedFor > 0) {
        audit(request, { action: 'auth.login.blocked_locked', target: `compte ${fresh.username}`, success: false, userId: fresh.id });
        throw accountLocked(accountLockedFor);
      }
      return fresh;
    });

    const now = Date.now();
    const deviceId = deviceIdFromRequest(request) ?? issueDeviceCookie(reply);
    request.client = { ...request.client, deviceId };

    const token = randomToken(32);
    const tokenHash = hashChallengeToken(token);
    const code = randomDigits(6);

    db.transaction(() => {
      db.prepare('DELETE FROM login_challenges WHERE expires_at <= ?').run(now);
      // Borne le nombre de connexions en cours par compte : les plus anciennes sont abandonnées.
      db.prepare(
        `DELETE FROM login_challenges WHERE user_id = ? AND id NOT IN (SELECT id FROM login_challenges WHERE user_id = ? ORDER BY id DESC LIMIT ?)`,
      ).run(user.id, user.id, MAX_PENDING_CHALLENGES - 1);
      db.prepare(
        `INSERT INTO login_challenges (token_hash, user_id, stage, email_code_hash, email_code_expires_at, attempts, emails_sent, ip, country, user_agent, device_id, created_at, expires_at)
         VALUES (?, ?, 'second_factor', ?, ?, 0, 1, ?, ?, ?, ?, ?, ?)`,
      ).run(
        tokenHash,
        user.id,
        hashEmailCode({ token_hash: tokenHash }, code),
        now + CODE_TTL_MS,
        request.client.ip,
        request.client.country,
        request.client.userAgent.slice(0, 512),
        deviceId,
        now,
        now + CHALLENGE_TTL_MS,
      );
    })();

    try {
      await sendLoginCodeMail(user, code, request.client);
    } catch (err) {
      db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').run(tokenHash);
      throw mailFailure(request, user, err);
    }

    reply.setCookie(CHALLENGE_COOKIE, token, { ...cookieOptions, maxAge: CHALLENGE_TTL_MS / 1000 });
    audit(request, { action: 'auth.login.password_ok', target: `compte ${user.username}`, userId: user.id });
    return { data: { step: 'second_factor', emailHint: emailHint(user.email) } };
  });

  // ── Étape 2 : code mail ET (TOTP ou code de secours) ──
  app.post('/api/auth/login/verify', { config: { public: true } }, async (request, reply): Promise<{ data: LoginStepResponse }> => {
    const challenge = loadChallenge(request);
    const user = challenge ? findUserById(challenge.user_id) : null;
    if (!challenge || !user) {
      destroyChallenge(reply, challenge);
      throw loginExpired();
    }
    if (challenge.stage !== 'second_factor') throw badRequest('Étape de connexion inattendue');

    const locked = lockRemainingSeconds(user);
    if (locked > 0) {
      destroyChallenge(reply, challenge);
      throw accountLocked(locked);
    }

    const body = verifySchema.parse(request.body);
    request.client = { ...request.client, deviceId: challenge.device_id };

    if (!takeAttempt(challenge)) {
      destroyChallenge(reply, challenge);
      throw loginExpired();
    }

    const now = Date.now();
    // Les deux facteurs sont toujours évalués, et la réponse ne dit jamais lequel est faux.
    const emailOk =
      challenge.email_code_hash !== null &&
      challenge.email_code_expires_at !== null &&
      safeEqual(hashEmailCode(challenge, body.emailCode), challenge.email_code_hash) &&
      challenge.email_code_expires_at > now;

    const method: 'totp' | 'backup_code' = body.totpCode !== undefined ? 'totp' : 'backup_code';
    let totpStep: number | null = null;
    let backupId: number | null = null;
    if (body.totpCode !== undefined) {
      totpStep = matchTotpStep(decryptTotpSecret(user.id, user.totp_secret_enc), body.totpCode, user.totp_last_step);
    } else {
      backupId = findBackupCode(user.id, body.backupCode ?? '');
    }
    const secondOk = totpStep !== null || backupId !== null;

    // Le second facteur n'est consommé (pas TOTP, code de secours) que si la vérification complète réussit.
    const accepted =
      emailOk &&
      secondOk &&
      db.transaction(() => {
        const consumed = totpStep !== null ? commitTotpStep(user.id, totpStep) : backupId !== null && consumeBackupCode(user.id, backupId);
        if (!consumed) return false;
        db.prepare('UPDATE login_challenges SET email_code_hash = NULL, email_code_expires_at = NULL WHERE id = ?').run(challenge.id);
        return true;
      })();

    if (!accepted) {
      throw challengeFailure(request, reply, user, challenge, 'second_factor', { method, emailCodeValid: emailOk, secondFactorValid: secondOk });
    }

    audit(request, { action: 'auth.login.second_factor_ok', target: `compte ${user.username}`, userId: user.id, details: { method } });
    if (method === 'backup_code') {
      audit(request, { action: 'auth.backup_code.used', target: `compte ${user.username}`, userId: user.id, details: { remaining: backupCodesStatus(user.id).remaining } });
    }

    // Contexte : appareil, IP et pays déjà vus pour CE compte ?
    const client = request.client;
    const reasons: NewContextReason[] = [];
    const deviceKnown = challenge.device_id ? db.prepare('SELECT 1 FROM known_devices WHERE user_id = ? AND device_hash = ?').get(user.id, challenge.device_id) : undefined;
    if (!deviceKnown) reasons.push('new_device');
    if (!db.prepare('SELECT 1 FROM known_ips WHERE user_id = ? AND ip = ?').get(user.id, client.ip)) reasons.push('new_ip');
    if (client.country && !db.prepare('SELECT 1 FROM known_ips WHERE user_id = ? AND country = ?').get(user.id, client.country)) reasons.push('new_country');

    if (reasons.length === 0) {
      return { data: finishLogin(request, reply, user, challenge, { reasons, method }) };
    }

    const deviceCode = randomDigits(8);
    db.prepare(
      `UPDATE login_challenges
       SET stage = 'device_confirmation', device_code_hash = ?, device_code_expires_at = ?, attempts = 0, emails_sent = 1,
           reasons = ?, ip = ?, country = ?, user_agent = ?, expires_at = ?, second_factor_method = ?
       WHERE id = ?`,
    ).run(hashDeviceCode(challenge, deviceCode), now + CODE_TTL_MS, JSON.stringify(reasons), client.ip, client.country, client.userAgent.slice(0, 512), now + CHALLENGE_TTL_MS, method, challenge.id);

    try {
      await sendDeviceCodeMail(user, deviceCode, reasons, client);
    } catch (err) {
      destroyChallenge(reply, challenge);
      throw mailFailure(request, user, err);
    }

    const token = request.cookies[CHALLENGE_COOKIE];
    if (isOpaqueToken(token)) reply.setCookie(CHALLENGE_COOKIE, token, { ...cookieOptions, maxAge: CHALLENGE_TTL_MS / 1000 });
    audit(request, { action: 'auth.login.device_confirmation_required', target: `compte ${user.username}`, userId: user.id, details: { reasons } });
    return { data: { step: 'device_confirmation', emailHint: emailHint(user.email), reasons } };
  });

  // ── Étape 3 : confirmation d'un appareil / d'une IP / d'un pays inconnu ──
  app.post('/api/auth/login/confirm-device', { config: { public: true } }, async (request, reply): Promise<{ data: LoginStepResponse }> => {
    const challenge = loadChallenge(request);
    const user = challenge ? findUserById(challenge.user_id) : null;
    if (!challenge || !user) {
      destroyChallenge(reply, challenge);
      throw loginExpired();
    }
    if (challenge.stage !== 'device_confirmation') throw badRequest('Étape de connexion inattendue');

    const locked = lockRemainingSeconds(user);
    if (locked > 0) {
      destroyChallenge(reply, challenge);
      throw accountLocked(locked);
    }

    request.client = { ...request.client, deviceId: challenge.device_id };
    // Le contexte confirmé par mail est celui de l'étape 2 : un changement d'IP en cours de route annule la connexion.
    if (challenge.ip !== request.client.ip) {
      destroyChallenge(reply, challenge);
      audit(request, { action: 'auth.login.context_changed', target: `compte ${user.username}`, success: false, userId: user.id });
      throw loginExpired();
    }

    const body = confirmDeviceSchema.parse(request.body);
    if (!takeAttempt(challenge)) {
      destroyChallenge(reply, challenge);
      throw loginExpired();
    }

    const ok =
      challenge.device_code_hash !== null &&
      challenge.device_code_expires_at !== null &&
      safeEqual(hashDeviceCode(challenge, body.code), challenge.device_code_hash) &&
      challenge.device_code_expires_at > Date.now() &&
      // Consommation atomique du code.
      db.prepare('UPDATE login_challenges SET device_code_hash = NULL WHERE id = ? AND device_code_hash IS NOT NULL').run(challenge.id).changes === 1;

    if (!ok) throw challengeFailure(request, reply, user, challenge, 'device_confirmation', {});

    const reasons = parseReasons(challenge.reasons);
    audit(request, { action: 'auth.login.device_confirmed', target: `compte ${user.username}`, userId: user.id, details: { reasons } });
    return { data: finishLogin(request, reply, user, challenge, { reasons, method: challenge.second_factor_method === 'backup_code' ? 'backup_code' : 'totp' }) };
  });

  // ── Renvoi du code de l'étape en cours ──
  app.post('/api/auth/login/resend-email', { config: { public: true } }, async (request, reply): Promise<{ data: LoginStepResponse }> => {
    const challenge = loadChallenge(request);
    const user = challenge ? findUserById(challenge.user_id) : null;
    if (!challenge || !user) {
      destroyChallenge(reply, challenge);
      throw loginExpired();
    }
    if (lockRemainingSeconds(user) > 0) {
      destroyChallenge(reply, challenge);
      throw accountLocked(lockRemainingSeconds(user));
    }
    request.client = { ...request.client, deviceId: challenge.device_id };

    const taken = db.prepare('UPDATE login_challenges SET emails_sent = emails_sent + 1 WHERE id = ? AND emails_sent < ?').run(challenge.id, MAX_EMAILS_PER_STAGE).changes === 1;
    if (!taken) {
      audit(request, { action: 'auth.login.resend_refused', target: `compte ${user.username}`, success: false, userId: user.id });
      throw rateLimited('Nombre maximal de renvois atteint pour cette connexion');
    }

    // Un nouveau code remplace le précédent ; il ne vit jamais plus longtemps que le challenge.
    const now = Date.now();
    const expiresAt = Math.min(now + CODE_TTL_MS, challenge.expires_at);
    const reasons = parseReasons(challenge.reasons);
    try {
      if (challenge.stage === 'second_factor') {
        const code = randomDigits(6);
        db.prepare('UPDATE login_challenges SET email_code_hash = ?, email_code_expires_at = ? WHERE id = ?').run(hashEmailCode(challenge, code), expiresAt, challenge.id);
        await sendLoginCodeMail(user, code, request.client);
      } else {
        const code = randomDigits(8);
        db.prepare('UPDATE login_challenges SET device_code_hash = ?, device_code_expires_at = ? WHERE id = ?').run(hashDeviceCode(challenge, code), expiresAt, challenge.id);
        await sendDeviceCodeMail(user, code, reasons, request.client);
      }
    } catch (err) {
      throw mailFailure(request, user, err);
    }

    audit(request, { action: 'auth.login.code_resent', target: `compte ${user.username}`, userId: user.id, details: { stage: challenge.stage } });
    return {
      data: { step: challenge.stage, emailHint: emailHint(user.email), ...(challenge.stage === 'device_confirmation' ? { reasons } : {}) },
    };
  });

  // ── Déconnexion ──
  app.post('/api/auth/logout', async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw unauthenticated();
    const deviceId = requestSession(request)?.device_id ?? null;
    revokeSession(auth.user.id, auth.sessionId);
    // Un appareil déconnecté ne reçoit plus de notifications push.
    const pushRemoved = removePushForDevice(auth.user.id, deviceId);
    clearSessionCookie(reply);
    audit(request, { action: 'auth.logout', target: `compte ${auth.user.username}`, details: { pushRemoved } });
    return { data: { ok: true } };
  });

  // ── Re-confirmation TOTP pour les actions critiques ──
  app.post('/api/auth/step-up', async (request, reply): Promise<{ data: StepUpResponse }> => {
    const auth = request.auth;
    const session = requestSession(request);
    const user = auth ? findUserById(auth.user.id) : null;
    if (!auth || !session || !user) throw unauthenticated();

    // Pendant un verrouillage du compte, aucune tentative de code n'est acceptée (pas de devinette illimitée).
    const locked = lockRemainingSeconds(user);
    if (locked > 0) {
      audit(request, { action: 'auth.step_up.failure', success: false, details: { reason: 'account_locked' } });
      throw accountLocked(locked);
    }

    const body = stepUpSchema.parse(request.body);
    const step = matchTotpStep(decryptTotpSecret(user.id, user.totp_secret_enc), body.totpCode, user.totp_last_step);
    if (step === null || !commitTotpStep(user.id, step)) {
      throw sessionAuthFailure(request, reply, user, 'step_up', 'Code 2FA incorrect');
    }

    const until = grantStepUp(session, Date.now());
    auth.stepUpUntil = until;
    clearFailedAttempts(user.id);
    audit(request, { action: 'auth.step_up.success' });
    return { data: { stepUpUntil: new Date(until).toISOString() } };
  });
}
