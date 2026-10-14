import type { FastifyRequest } from 'fastify';
import { securityAlert } from '../../core/alerts.js';
import { audit } from '../../core/audit.js';
import { db } from '../../db/index.js';
import type { ClientInfo } from '../../types/fastify.js';
import { deviceLabel } from './device.js';
import { ipRateKey } from './ip-allowlist.js';
import type { UserRow } from './users.js';

/**
 * Deux niveaux de verrouillage :
 *
 *  - verrou « appareils inconnus » (users.unknown_*) : alimenté par les échecs de mot de passe venant d'un
 *    appareil que le compte n'a jamais confirmé. Pendant ce verrou, toute tentative de connexion depuis un
 *    appareil inconnu reçoit la même réponse générique, que le mot de passe soit bon ou non. Il ne touche ni
 *    les appareils connus ni les sessions ouvertes : un anonyme qui connaît un identifiant ne peut pas
 *    enfermer le titulaire dehors.
 *  - verrou complet du compte (users.failed_attempts / locked_until) : alimenté uniquement par des échecs
 *    survenus après preuve du mot de passe, depuis un appareil connu ou depuis une session (second facteur,
 *    code d'appareil, step-up, mot de passe actuel, confirmation TOTP, mot de passe depuis un appareil connu).
 */

/** Échecs consécutifs avant verrouillage (pour chacun des deux niveaux). */
export const MAX_FAILED_ATTEMPTS = 5;
const LOCK_BASE_MS = 15 * 60_000;
const LOCK_MAX_MS = 24 * 3600_000;

/** Au-delà de ce nombre d'échecs par IP dans la fenêtre, l'IP est bloquée sur les routes d'authentification. */
export const IP_MAX_FAILURES = 10;
const IP_WINDOW_MS = 15 * 60_000;
const IP_BLOCK_MS = 15 * 60_000;

/** Sans échec depuis un appareil inconnu pendant ce délai, le compteur et l'escalade « appareils inconnus » repartent de zéro. */
const UNKNOWN_QUIET_RESET_MS = 24 * 3600_000;

/** Niveau de verrouillage alimenté par un échec. */
export type FailureScope = 'unknown_device' | 'account';

export type FailureKind = 'password' | 'second_factor' | 'device_confirmation' | 'step_up' | 'current_password' | 'totp_confirm';

const KIND_LABELS: Record<FailureKind, string> = {
  password: 'mot de passe',
  second_factor: 'second facteur (code mail / 2FA)',
  device_confirmation: "code de confirmation d'appareil",
  step_up: 'confirmation 2FA (step-up)',
  current_password: 'mot de passe actuel (changement de mot de passe)',
  totp_confirm: 'confirmation du nouveau secret 2FA',
};

/** Détails de l'appelant pour les alertes. Les valeurs sont échappées au rendu du mail. */
export function clientFacts(client: ClientInfo): [string, string | null][] {
  return [
    ['Adresse IP', client.ip],
    ['Pays', client.country],
    ['Navigateur', deviceLabel(client.userAgent)],
    ['User-Agent', client.userAgent.slice(0, 300) || null],
  ];
}

/** Durée du n-ième verrouillage consécutif : 15 min, 30 min, 1 h… plafonnée à 24 h. */
export function lockDurationMs(lockCount: number): number {
  const exponent = Math.min(Math.max(lockCount - 1, 0), 20);
  return Math.min(LOCK_BASE_MS * 2 ** exponent, LOCK_MAX_MS);
}

/** Secondes restantes de verrouillage du compte (0 = non verrouillé). */
export function lockRemainingSeconds(user: Pick<UserRow, 'locked_until'>, now = Date.now()): number {
  return user.locked_until && user.locked_until > now ? Math.ceil((user.locked_until - now) / 1000) : 0;
}

/** Secondes restantes du verrou « appareils inconnus » (0 = inactif). */
export function unknownDeviceLockRemainingSeconds(user: Pick<UserRow, 'unknown_locked_until'>, now = Date.now()): number {
  return user.unknown_locked_until && user.unknown_locked_until > now ? Math.ceil((user.unknown_locked_until - now) / 1000) : 0;
}

/** Vrai si cet appareil (HMAC du cookie d'appareil) a déjà été confirmé par une connexion complète de CE compte. */
export function isKnownDevice(userId: number, deviceId: string | null): boolean {
  if (!deviceId) return false;
  return db.prepare('SELECT 1 FROM known_devices WHERE user_id = ? AND device_hash = ?').get(userId, deviceId) !== undefined;
}

/** Secondes restantes de blocage de l'IP sur les routes d'authentification (0 = non bloquée). */
export function ipBlockRemainingSeconds(ip: string, now = Date.now()): number {
  const row = db.prepare('SELECT blocked_until FROM auth_ip_blocks WHERE ip = ?').get(ipRateKey(ip)) as { blocked_until: number } | undefined;
  return row && row.blocked_until > now ? Math.ceil((row.blocked_until - now) / 1000) : 0;
}

export interface FailureResult {
  /** Fin du verrou complet si CET échec vient de verrouiller le compte. */
  lockedUntil: number | null;
  /** Fin du verrou « appareils inconnus » si CET échec vient de le poser ou de le prolonger. */
  unknownLockedUntil: number | null;
  ipBlocked: boolean;
}

/**
 * Enregistre un échec d'authentification : compteur par IP (blocage + alerte « activité suspecte »),
 * compteur du niveau de verrouillage concerné si le compte est identifié, journal d'audit et alerte regroupée.
 *
 * `scope` : 'unknown_device' pour un échec de mot de passe venant d'un appareil inconnu (les échecs continuent
 * d'être comptés pendant le verrou, qui se prolonge tant que l'attaque dure) ; 'account' (défaut) pour tout le
 * reste (un échec pendant le verrou complet ne le prolonge pas).
 */
export function recordAuthFailure(
  request: FastifyRequest,
  input: { user: UserRow | null; kind: FailureKind; scope?: FailureScope; details?: Record<string, unknown> },
): FailureResult {
  const { user, kind } = input;
  const scope: FailureScope = input.scope ?? 'account';
  const now = Date.now();
  const client = request.client;
  // Compteur par IPv4 ou par préfixe IPv6 /64.
  const ipKey = ipRateKey(client.ip);

  const { lockedUntil, unknownLockedUntil, ipBlocked } = db.transaction((): FailureResult => {
    let lockedUntil: number | null = null;
    let unknownLockedUntil: number | null = null;
    let ipBlocked = false;

    db.prepare('INSERT INTO auth_failures (ip, identifier, kind, at) VALUES (?, ?, ?, ?)').run(ipKey, user?.username ?? null, kind, now);

    // Fenêtre glissante, repartant de zéro après un blocage purgé.
    const block = db.prepare('SELECT blocked_until FROM auth_ip_blocks WHERE ip = ?').get(ipKey) as { blocked_until: number } | undefined;
    const since = Math.max(now - IP_WINDOW_MS, block ? block.blocked_until : 0);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM auth_failures WHERE ip = ? AND at > ?').get(ipKey, since) as { n: number };
    if (n > IP_MAX_FAILURES && !(block && block.blocked_until > now)) {
      db.prepare('INSERT INTO auth_ip_blocks (ip, blocked_until, created_at) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET blocked_until = excluded.blocked_until, created_at = excluded.created_at').run(
        ipKey,
        now + IP_BLOCK_MS,
        now,
      );
      ipBlocked = true;
    }

    if (user && scope === 'unknown_device') {
      const fresh = db.prepare('SELECT unknown_failed_attempts, unknown_lock_count, unknown_locked_until, unknown_last_failure_at FROM users WHERE id = ?').get(user.id) as
        | Pick<UserRow, 'unknown_failed_attempts' | 'unknown_lock_count' | 'unknown_locked_until' | 'unknown_last_failure_at'>
        | undefined;
      if (fresh) {
        const quiet = fresh.unknown_last_failure_at === null || now - fresh.unknown_last_failure_at > UNKNOWN_QUIET_RESET_MS;
        let attempts = (quiet ? 0 : fresh.unknown_failed_attempts) + 1;
        let lockCount = quiet ? 0 : fresh.unknown_lock_count;
        let until = fresh.unknown_locked_until;
        if (attempts >= MAX_FAILED_ATTEMPTS) {
          attempts = 0;
          lockCount += 1;
          until = Math.max(until ?? 0, now + lockDurationMs(lockCount));
          unknownLockedUntil = until;
        }
        db.prepare('UPDATE users SET unknown_failed_attempts = ?, unknown_lock_count = ?, unknown_locked_until = ?, unknown_last_failure_at = ? WHERE id = ?').run(attempts, lockCount, until, now, user.id);
      }
    } else if (user) {
      const fresh = db.prepare('SELECT failed_attempts, lock_count, locked_until FROM users WHERE id = ?').get(user.id) as
        | Pick<UserRow, 'failed_attempts' | 'lock_count' | 'locked_until'>
        | undefined;
      if (fresh && !(fresh.locked_until && fresh.locked_until > now)) {
        const attempts = fresh.failed_attempts + 1;
        if (attempts >= MAX_FAILED_ATTEMPTS) {
          const lockCount = fresh.lock_count + 1;
          lockedUntil = now + lockDurationMs(lockCount);
          db.prepare('UPDATE users SET failed_attempts = 0, lock_count = ?, locked_until = ? WHERE id = ?').run(lockCount, lockedUntil, user.id);
        } else {
          db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(attempts, user.id);
        }
      }
    }
    return { lockedUntil, unknownLockedUntil, ipBlocked };
  })();

  audit(request, {
    action: `auth.${kind === 'password' ? 'login' : kind}.failure`,
    target: user ? `compte ${user.username}` : null,
    success: false,
    userId: user?.id ?? null,
    details: { reason: kind, knownAccount: Boolean(user), ...(user ? { scope } : {}), ...input.details },
  });

  securityAlert({
    kind: 'login_failed',
    severity: 'warning',
    title: user ? `Échec d'authentification sur le compte ${user.username}` : 'Échec de connexion (identifiant inconnu)',
    summary: `Une tentative d'authentification a échoué à l'étape « ${KIND_LABELS[kind]} ».`,
    facts: [['Compte', user?.username ?? 'identifiant inconnu'], ...clientFacts(client)],
    userId: user?.id ?? null,
    // Compte connu : une alerte par IP et par compte. Identifiant inconnu (bruit de fond d'Internet, peu
    // informatif) : une seule alerte toutes IP confondues par fenêtre.
    throttleKey: user ? `${ipKey}:${user.id}` : 'identifiant-inconnu',
  });

  if (lockedUntil !== null && user) {
    const minutes = Math.round((lockedUntil - now) / 60_000);
    audit(request, { action: 'auth.account.locked', target: `compte ${user.username}`, success: false, userId: user.id, details: { minutes } });
    securityAlert({
      kind: 'account_locked',
      severity: 'critical',
      title: `Compte ${user.username} verrouillé`,
      summary: `Le compte a été verrouillé pendant ${minutes} minute(s) après ${MAX_FAILED_ATTEMPTS} échecs d'authentification consécutifs.`,
      facts: [['Compte', user.username], ...clientFacts(client)],
      userId: user.id,
      throttleKey: `compte:${user.id}`,
      throttleMs: 60_000,
    });
  }

  if (unknownLockedUntil !== null && user) {
    const minutes = Math.round((unknownLockedUntil - now) / 60_000);
    audit(request, { action: 'auth.unknown_devices.locked', target: `compte ${user.username}`, success: false, userId: user.id, details: { minutes } });
    securityAlert({
      kind: 'account_locked',
      severity: 'critical',
      title: `Connexions depuis des appareils inconnus bloquées : ${user.username}`,
      summary: `Après ${MAX_FAILED_ATTEMPTS} mots de passe erronés venant d'appareils inconnus, toute connexion au compte ${user.username} depuis un appareil jamais confirmé est refusée pendant ${minutes} minute(s). Vos appareils connus et vos sessions ouvertes ne sont pas affectés.`,
      facts: [['Compte', user.username], ...clientFacts(client)],
      userId: user.id,
      throttleKey: `inconnus:${user.id}`,
    });
  }

  if (ipBlocked) {
    audit(request, { action: 'auth.ip.blocked', target: client.ip, success: false, userId: null, details: { minutes: IP_BLOCK_MS / 60_000 } });
    securityAlert({
      kind: 'suspicious_activity',
      severity: 'critical',
      title: 'Activité suspecte : adresse IP bloquée',
      summary: `Plus de ${IP_MAX_FAILURES} échecs d'authentification en 15 minutes depuis la même adresse : elle est bloquée 15 minutes sur les routes d'authentification.`,
      facts: clientFacts(client),
      throttleKey: `ip:${client.ip}`,
    });
  }

  return { lockedUntil, unknownLockedUntil, ipBlocked };
}

/**
 * Après une connexion complète réussie : remise à zéro des compteurs du verrou complet. Le verrou « appareils
 * inconnus » n'est levé que si la connexion vient elle-même de confirmer un nouvel appareil : une connexion du
 * titulaire depuis un appareil connu ne doit pas rouvrir des essais à un attaquant en cours.
 */
export function clearAccountFailures(userId: number, options: { unknownDevices?: boolean } = {}): void {
  db.prepare('UPDATE users SET failed_attempts = 0, lock_count = 0, locked_until = NULL WHERE id = ?').run(userId);
  if (options.unknownDevices) {
    db.prepare('UPDATE users SET unknown_failed_attempts = 0, unknown_lock_count = 0, unknown_locked_until = NULL, unknown_last_failure_at = NULL WHERE id = ?').run(userId);
  }
}

/** Après une vérification 2FA réussie en cours de session (step-up) : seul le compteur d'échecs repart de zéro. */
export function clearFailedAttempts(userId: number): void {
  db.prepare('UPDATE users SET failed_attempts = 0 WHERE id = ?').run(userId);
}
