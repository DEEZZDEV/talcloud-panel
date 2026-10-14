import type { PushPublicKey, PushSubscribeRequest, PushUnsubscribeRequest, SettingsTestResult } from '@shared/api-types';
import { api } from '@/lib/api';

/** Notifications push du navigateur : service worker minimal (`/sw.js`), aucune mise en cache. */

export type PushSupport = 'supported' | 'unsupported' | 'insecure';

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'insecure';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return 'supported';
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const raw = window.atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null;
  const existing = await navigator.serviceWorker.getRegistration('/');
  return existing ? existing.pushManager.getSubscription() : null;
}

/** Demande la permission, abonne le navigateur et enregistre l'abonnement côté serveur. */
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permission refusée : autorisez les notifications pour ce site dans votre navigateur.');
  const { publicKey } = await api.get<PushPublicKey>('/api/push/public-key');
  const worker = await registration();
  const subscription = (await worker.pushManager.getSubscription()) ?? (await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) }));
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("Abonnement push incomplet renvoyé par le navigateur.");
  const body: PushSubscribeRequest = { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
  await api.post('/api/push/subscribe', body);
}

export async function disablePush(): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  const body: PushUnsubscribeRequest = { endpoint: subscription.endpoint };
  await api.post('/api/push/unsubscribe', body);
  await subscription.unsubscribe();
}

export const sendTestPush = (): Promise<SettingsTestResult> => api.post<SettingsTestResult>('/api/push/test');
