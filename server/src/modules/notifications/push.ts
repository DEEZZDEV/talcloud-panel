import type { PanelNotification, PushPayload } from '@shared/api-types';
import webpush from 'web-push';
import { z } from 'zod';
import { config } from '../../config.js';
import { decryptJson, encryptJson } from '../../core/crypto.js';
import { upstreamFetch } from '../../core/http.js';
import { getSettings, setSettings } from '../../core/settings.js';
import { db, transaction } from '../../db/index.js';
import { oneLine } from './format.js';

/** Espace de réglages INTERNE (aucune route ne l'expose) : paire de clés VAPID, chiffrée comme tout réglage. */
const VAPID_NAMESPACE = 'notifications.vapid';
const MAX_SUBSCRIPTIONS_PER_USER = 10;
const PUSH_TTL_SECONDS = 24 * 3600;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cachedKeys: VapidKeys | null = null;

const isVapidKeys = (value: unknown): value is VapidKeys =>
  typeof value === 'object' && value !== null && typeof (value as VapidKeys).publicKey === 'string' && typeof (value as VapidKeys).privateKey === 'string';

/** Paire de clés VAPID, générée au premier besoin. La clé privée ne quitte jamais ce module. */
function vapidKeys(): VapidKeys {
  if (cachedKeys) return cachedKeys;
  cachedKeys = transaction(() => {
    const stored = getSettings<VapidKeys>(VAPID_NAMESPACE);
    if (isVapidKeys(stored)) return stored;
    const generated = webpush.generateVAPIDKeys();
    const keys: VapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    setSettings(VAPID_NAMESPACE, keys, null);
    return keys;
  });
  return cachedKeys;
}

export const getVapidPublicKey = (): string => vapidKeys().publicKey;

// Le « sujet » VAPID doit être une URL https ou une adresse mailto.
const vapidSubject = (): string => (config.publicUrl.startsWith('https://') ? config.publicUrl : 'mailto:admin@talcloud.invalid');

/**
 * Services push des navigateurs. Le serveur émet une requête vers l'URL fournie par le navigateur : la restreindre
 * aux services connus (en plus de https) empêche de s'en servir pour atteindre un hôte arbitraire (SSRF).
 */
const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com', // Chrome, Edge (Android), Brave, Opera…
  'android.googleapis.com',
  '.push.services.mozilla.com', // Firefox
  '.notify.windows.com', // Edge
  '.push.apple.com', // Safari
] as const;

/** Retourne l'URL canonique d'un point de terminaison push acceptable, ou null. */
export function parsePushEndpoint(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\\\x00-\x1f\x7f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') return null;
  const host = url.hostname.toLowerCase();
  const known = PUSH_HOST_SUFFIXES.some((suffix) => (suffix.startsWith('.') ? host.endsWith(suffix) && host.length > suffix.length : host === suffix));
  return known ? url.href : null;
}

const base64url = (bytes: number) =>
  z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Clé invalide')
    .transform((value) => value.replace(/=+$/, ''))
    .refine((value) => Buffer.from(value, 'base64url').length === bytes, 'Clé de longueur invalide');

/** POST /api/push/subscribe — le `PushSubscription.toJSON()` du navigateur (champ `expirationTime` toléré). */
export const pushSubscribeSchema = z.strictObject({
  endpoint: z
    .string()
    .max(2048)
    .transform((value, ctx) => {
      const endpoint = parsePushEndpoint(value);
      if (endpoint === null) {
        ctx.addIssue({ code: 'custom', message: 'Point de terminaison push invalide (URL https d’un service push de navigateur attendue)' });
        return z.NEVER;
      }
      return endpoint;
    }),
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({ p256dh: base64url(65), auth: base64url(16) }),
});

export const pushUnsubscribeSchema = z.strictObject({ endpoint: z.string().min(1).max(2048) });

interface SubscriptionRow {
  id: number;
  user_id: number;
  endpoint: string;
  keys_enc: string;
}

const keysContext = (endpoint: string) => `push:${endpoint}`;

/** Enregistre (ou rattache à l'utilisateur courant) un abonnement. Les clés sont chiffrées en base. */
export interface SubscriptionOwner {
  userId: number;
  /** Identifiant d'appareil (HMAC du cookie d'appareil), obligatoire. */
  deviceId: string;
  sessionId: string | null;
}

/**
 * Enregistre un abonnement, rattaché au compte ET à l'appareil courants. Un point de terminaison déjà connu
 * (même navigateur réabonné, éventuellement par l'autre compte ou depuis un autre appareil) remplace l'ancien.
 * Les clés sont chiffrées en base.
 */
export function saveSubscription(owner: SubscriptionOwner, subscription: z.infer<typeof pushSubscribeSchema>, userAgent: string | null): void {
  if (!owner.deviceId) throw new Error('Appareil non identifié');
  const { userId } = owner;
  const keysEnc = encryptJson(subscription.keys, keysContext(subscription.endpoint));
  transaction(() => {
    db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys_enc, user_agent, created_at, device_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_enc = excluded.keys_enc, user_agent = excluded.user_agent,
         created_at = excluded.created_at, device_id = excluded.device_id, session_id = excluded.session_id`,
    ).run(userId, subscription.endpoint, keysEnc, userAgent?.slice(0, 512) ?? null, Date.now(), owner.deviceId, owner.sessionId);
    // Plafond par compte : les plus anciens abonnements sont retirés.
    db.prepare(
      'DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)',
    ).run(userId, userId, MAX_SUBSCRIPTIONS_PER_USER);
  });
}

/** Supprime un abonnement du compte courant uniquement. */
export function removeSubscription(userId: number, endpoint: string): boolean {
  return db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId).changes > 0;
}

// Seuls les abonnements d'un appareil encore connu du compte reçoivent quelque chose.
const KNOWN_DEVICE = 'EXISTS (SELECT 1 FROM known_devices k WHERE k.user_id = p.user_id AND k.device_hash = p.device_id)';

function subscriptionsFor(userId: number | null): SubscriptionRow[] {
  // Ménage : un abonnement dont l'appareil n'est plus connu (oublié, ou ancienne ligne sans appareil) est supprimé.
  db.prepare(
    'DELETE FROM push_subscriptions WHERE NOT EXISTS (SELECT 1 FROM known_devices k WHERE k.user_id = push_subscriptions.user_id AND k.device_hash = push_subscriptions.device_id)',
  ).run();
  return (
    userId === null
      ? db.prepare(`SELECT p.id, p.user_id, p.endpoint, p.keys_enc FROM push_subscriptions p WHERE ${KNOWN_DEVICE}`).all()
      : db.prepare(`SELECT p.id, p.user_id, p.endpoint, p.keys_enc FROM push_subscriptions p WHERE p.user_id = ? AND ${KNOWN_DEVICE}`).all(userId)
  ) as SubscriptionRow[];
}

// ── Retrait des abonnements (appelé par le module d'authentification et la CLI) ──

/** Retire les abonnements d'un appareil du compte (déconnexion, révocation d'une session, oubli de l'appareil). */
export function removePushForDevice(userId: number, deviceId: string | null | undefined): number {
  if (!deviceId) return 0;
  return db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND device_id = ?').run(userId, deviceId).changes;
}

/** Retire tous les abonnements du compte sauf ceux de l'appareil courant (tous si l'appareil est inconnu). */
export function removePushExceptDevice(userId: number, deviceId: string | null | undefined): number {
  if (!deviceId) return removeAllPush(userId);
  return db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND device_id IS NOT ?').run(userId, deviceId).changes;
}

/** Retire tous les abonnements du compte (commandes de secours de la CLI). */
export function removeAllPush(userId: number): number {
  return db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId).changes;
}

export interface PushSubscriptionRow {
  id: number;
  device_id: string;
  user_agent: string | null;
  created_at: number;
}

/** Abonnements du compte (sans point de terminaison ni clés). */
export function listPushSubscriptions(userId: number): PushSubscriptionRow[] {
  return db.prepare('SELECT id, device_id, user_agent, created_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(userId) as PushSubscriptionRow[];
}

/** Supprime un abonnement du compte par son identifiant. false s'il n'existe pas ou appartient à l'autre compte. */
export function removePushSubscriptionById(userId: number, id: number): boolean {
  return db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, userId).changes === 1;
}

const deleteSubscription = (id: number): void => void db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);

export interface PushResult {
  sent: number;
  failed: number;
  removed: number;
}

type Outcome = 'sent' | 'failed' | 'removed';

async function sendOne(row: SubscriptionRow, payload: string, keys: VapidKeys): Promise<Outcome> {
  const endpoint = parsePushEndpoint(row.endpoint);
  let subscriptionKeys: { p256dh: string; auth: string };
  try {
    if (endpoint === null) throw new Error('endpoint');
    subscriptionKeys = decryptJson<{ p256dh: string; auth: string }>(row.keys_enc, keysContext(row.endpoint));
  } catch {
    // Abonnement inutilisable (point de terminaison refusé ou clés illisibles) : le navigateur se réabonnera.
    deleteSubscription(row.id);
    return 'removed';
  }

  // web-push chiffre la charge utile et signe l'en-tête VAPID ; l'envoi passe par core/http.ts (délai, pas de redirection).
  const details = webpush.generateRequestDetails({ endpoint, keys: subscriptionKeys }, payload, {
    vapidDetails: { subject: vapidSubject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: PUSH_TTL_SECONDS,
    urgency: 'high',
  });
  const res = await upstreamFetch('notifications', endpoint, { method: 'POST', timeoutMs: 8000, headers: details.headers, body: details.body });
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 404 || res.status === 410) {
    deleteSubscription(row.id);
    return 'removed';
  }
  return res.ok ? 'sent' : 'failed';
}

/** Envoie une charge utile à tous les abonnements d'un compte (ou de tous si `userId` est null). Ne lève pas. */
export async function sendPush(userId: number | null, payload: PushPayload): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, removed: 0 };
  let rows: SubscriptionRow[];
  let keys: VapidKeys;
  let body: string;
  try {
    rows = subscriptionsFor(userId);
    if (rows.length === 0) return result;
    keys = vapidKeys();
    body = JSON.stringify(payload);
  } catch {
    return result;
  }
  const outcomes = await Promise.allSettled(rows.map((row) => sendOne(row, body, keys)));
  for (const outcome of outcomes) result[outcome.status === 'fulfilled' ? outcome.value : 'failed'] += 1;
  return result;
}

/** Charge utile du service worker : uniquement le titre, le corps (tronqués) et la page à ouvrir. */
export function pushPayloadFor(notification: PanelNotification): PushPayload {
  return {
    title: oneLine(notification.title, 120),
    body: oneLine(notification.body, 300),
    url: '/notifications',
    tag: `notification-${notification.id}`,
  };
}

export const sendPushForNotification = (notification: PanelNotification, userId: number | null): Promise<PushResult> =>
  sendPush(userId, pushPayloadFor(notification));

export const sendTestPush = (userId: number): Promise<PushResult> =>
  sendPush(userId, { title: 'TalCloud Panel', body: 'Les notifications push fonctionnent sur cet appareil.', url: '/notifications', tag: 'push-test' });

/** Tests uniquement : oublie la paire de clés en mémoire. */
export function resetVapidCache(): void {
  cachedKeys = null;
}
