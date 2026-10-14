import { createECDH, createHmac, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { OrderNotificationData, PanelNotification, PushPublicKey, ServerEvent, SettingsTestResult, SettingsView, UnreadCount, WhmcsWebhookPayload } from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, HOOK_SECRET } = vi.hoisted(() => {
  // Posé AVANT l'import de l'application : config.ts lit l'environnement à l'import.
  const secret = 'secret-webhook-de-test-0123456789-abcdefghijklmnop';
  process.env.WHMCS_HOOK_SECRET = secret;
  process.env.WHMCS_HOOK_IPS = '203.0.113.0/24, 2001:db8:1::/48';
  return { fetchMock: vi.fn(), HOOK_SECRET: secret };
});

// Aucun appel réseau réel : tout le HTTP sortant du module passe par core/http.ts.
vi.mock('../src/core/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/http.js')>()),
  upstreamFetch: fetchMock,
}));

import { flushAlerts, resetAlertThrottle } from '../src/core/alerts.js';
import { upstream } from '../src/core/errors.js';
import { publish, type BusMessage } from '../src/core/events.js';
import { outbox } from '../src/core/mailer.js';
import { getSettings, setSettings } from '../src/core/settings.js';
import { db } from '../src/db/index.js';
import { revokeSession } from '../src/modules/auth/sessions.js';
import { buildDiscordMessage, discordText } from '../src/modules/notifications/discord.js';
import { parsePushEndpoint } from '../src/modules/notifications/push.js';
import { flushNotifications, notify } from '../src/modules/notifications/service.js';
import { parseDiscordWebhookUrl } from '../src/modules/notifications/settings.js';
import { EventStream, MAX_STREAMS_PER_USER, openStreamCount, shouldDeliver } from '../src/modules/notifications/sse.js';
import { purgeNotifications } from '../src/modules/notifications/store.js';
import { purgeWebhookEvents, resetWebhookRejectionLog, verifyWebhookSignature, WEBHOOK_BODY_LIMIT, WEBHOOK_EVENT_RETENTION_MS } from '../src/modules/notifications/webhook.js';
import { advance, Browser, buildTestApp, CHROME_UA, createTestAdmin, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

const DISCORD_URL = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
const WEBHOOK = '/api/webhooks/whmcs';

let app: FastifyInstance;
let alice: TestAdmin;
let bob: TestAdmin;
let aliceBrowser: Browser;
let bobBrowser: Browser;

let hookIpCounter = 0;
/** IP distincte dans la plage autorisée par WHMCS_HOOK_IPS (chaque test a son propre compteur de débit). */
const hookIp = (): string => `203.0.113.${(hookIpCounter += 1)}`;

let eventCounter = 0;
const basePayload = (overrides: Partial<WhmcsWebhookPayload> = {}): WhmcsWebhookPayload => ({
  eventId: `order_created:${(eventCounter += 1)}`,
  event: 'order_created',
  orderId: 1000 + eventCounter,
  invoiceId: 2000 + eventCounter,
  clientId: 42,
  clientName: 'Jean Dupont',
  clientEmail: 'jean.dupont@exemple.test',
  products: ['Minecraft 8 Go'],
  amount: 12,
  currency: 'EUR',
  gateway: 'stripe',
  gatewayName: 'Stripe',
  ...overrides,
});

const sign = (timestamp: number | string, body: string | Buffer, secret = HOOK_SECRET): string =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`;

interface HookOptions {
  ip?: string;
  timestamp?: number;
  signature?: string;
  /** Corps réellement envoyé (par défaut : celui qui a été signé). */
  sentBody?: string;
  headers?: Record<string, string>;
  omit?: ('timestamp' | 'signature')[];
}

async function callHook(payload: unknown, options: HookOptions = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-talcloud-timestamp': String(timestamp),
    'x-talcloud-signature': options.signature ?? sign(timestamp, body),
    ...options.headers,
  };
  if (options.omit?.includes('timestamp')) delete headers['x-talcloud-timestamp'];
  if (options.omit?.includes('signature')) delete headers['x-talcloud-signature'];
  return app.inject({ method: 'POST', url: WEBHOOK, headers, payload: options.sentBody ?? body, remoteAddress: options.ip ?? hookIp() });
}

const notificationsOf = (type: string): { id: number; title: string; body: string; data: string | null; user_id: number | null }[] =>
  db.prepare('SELECT id, title, body, data, user_id FROM notifications WHERE type = ? ORDER BY id').all(type) as never;
const countOrders = (): number => (db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type IN ('order', 'payment')").get() as { c: number }).c;

const okResponse = () => ({ ok: true, status: 204, body: null });

function setNotificationSettings(values: Record<string, unknown>): void {
  setSettings('notifications', { discordEnabled: false, notifyOrders: true, notifyPayments: true, gatewayAccounts: {}, ...values }, null);
}

beforeAll(async () => {
  useFakeClock();
  app = await buildTestApp();
  alice = await createTestAdmin('alice');
  bob = await createTestAdmin('bob');
  aliceBrowser = new Browser(app, uniqueIp());
  bobBrowser = new Browser(app, uniqueIp());
  await aliceBrowser.login(alice);
  await bobBrowser.login(bob);
});

beforeEach(async () => {
  await flushAlerts();
  await flushNotifications();
  advance(61_000);
  // Les sessions de test restent actives malgré l'avance de l'horloge.
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE revoked_at IS NULL').run(Date.now());
  resetAlertThrottle();
  resetWebhookRejectionLog();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => okResponse());
  setNotificationSettings({});
});

afterAll(async () => {
  await app.close();
});

describe('webhook WHMCS — authentification', () => {
  it('accepte une requête correctement signée, sans session ni jeton CSRF', async () => {
    const res = await callHook(basePayload());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { received: true } });
  });

  it('refuse avec le même 401 : signature fausse, absente, mal formée, mauvais secret, corps altéré, horodatage périmé ou futur', async () => {
    const before = countOrders();
    const payload = basePayload();
    const body = JSON.stringify(payload);
    const now = Math.floor(Date.now() / 1000);

    const failures = [
      await callHook(payload, { signature: `sha256=${'0'.repeat(64)}` }),
      await callHook(payload, { omit: ['signature'] }),
      await callHook(payload, { omit: ['timestamp'] }),
      await callHook(payload, { signature: sign(now, body).replace('sha256=', '') }),
      await callHook(payload, { signature: sign(now, body, 'un-autre-secret-de-plus-de-32-caracteres-xxxx') }),
      // Corps altéré après signature (un seul caractère).
      await callHook(payload, { sentBody: body.replace('"amount":12', '"amount":13') }),
      // Signature valide mais horodatage hors tolérance (± 5 minutes).
      await callHook(payload, { timestamp: now - 301 }),
      await callHook(payload, { timestamp: now + 301 }),
      // Horodatage modifié sans re-signer.
      await callHook(payload, { timestamp: now - 10, signature: sign(now, body) }),
      await callHook(payload, { headers: { 'x-talcloud-timestamp': `${now}abc` } }),
    ];

    for (const res of failures) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Requête refusée' } });
    }
    // Toutes les réponses d'échec sont identiques au caractère près.
    expect(new Set(failures.map((res) => res.payload)).size).toBe(1);
    expect(countOrders()).toBe(before);
    // Aucun identifiant d'évènement n'est consommé par une requête refusée.
    expect(db.prepare('SELECT 1 FROM webhook_events WHERE event_id = ?').get(payload.eventId)).toBeUndefined();

    // La même charge utile, correctement signée, passe ensuite.
    expect((await callHook(payload)).statusCode).toBe(200);
  });

  it('accepte un horodatage dans la tolérance de 5 minutes', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await callHook(basePayload(), { timestamp: now - 299 })).statusCode).toBe(200);
    expect((await callHook(basePayload(), { timestamp: now + 299 })).statusCode).toBe(200);
  });

  it('vérifie la signature sur les octets bruts, avant toute analyse du JSON', async () => {
    // Corps non JSON mais correctement signé : l'appelant est authentifié → 400, pas 401.
    const garbage = await callHook('ceci n’est pas du JSON');
    expect(garbage.statusCode).toBe(400);
    // Corps non JSON et non signé : 401, le contenu n'a pas été examiné.
    expect((await callHook('ceci n’est pas du JSON', { signature: `sha256=${'a'.repeat(64)}` })).statusCode).toBe(401);
    // Un JSON équivalent mais d'octets différents (espaces) n'est pas couvert par la signature d'origine.
    const payload = basePayload();
    const compact = JSON.stringify(payload);
    const spaced = JSON.stringify(payload, null, 1);
    const now = Math.floor(Date.now() / 1000);
    expect((await callHook(payload, { sentBody: spaced, signature: sign(now, compact), timestamp: now })).statusCode).toBe(401);
  });

  it('verifyWebhookSignature : cas limites', () => {
    const body = Buffer.from('{"a":1}');
    const now = 1_800_000_000_000;
    const ts = String(now / 1000);
    expect(verifyWebhookSignature(HOOK_SECRET, ts, sign(ts, body), body, now)).toBeNull();
    expect(verifyWebhookSignature(HOOK_SECRET, ts, sign(ts, body).toUpperCase().replace('SHA256', 'sha256'), body, now)).toBeNull();
    expect(verifyWebhookSignature(HOOK_SECRET, ts, sign(ts, body), Buffer.from('{"a":2}'), now)).toBe('signature');
    expect(verifyWebhookSignature(HOOK_SECRET, ts, undefined, body, now)).toBe('malformed');
    expect(verifyWebhookSignature(HOOK_SECRET, undefined, sign('', body), body, now)).toBe('malformed');
    expect(verifyWebhookSignature(HOOK_SECRET, [ts, ts], sign(ts, body), body, now)).toBe('malformed');
    expect(verifyWebhookSignature(HOOK_SECRET, '-5', sign('-5', body), body, now)).toBe('malformed');
    expect(verifyWebhookSignature(HOOK_SECRET, ts, sign(ts, body), body, now + 301_000)).toBe('timestamp');
    expect(verifyWebhookSignature(HOOK_SECRET, ts, sign(ts, body), body, now - 301_000)).toBe('timestamp');
    expect(verifyWebhookSignature(HOOK_SECRET, ts, sign(ts, body), body, now + 300_000)).toBeNull();
  });

  it('refuse une IP absente de WHMCS_HOOK_IPS, même avec une signature valide', async () => {
    const before = countOrders();
    const payload = basePayload();
    const outside = await callHook(payload, { ip: '198.51.100.77' });
    expect(outside.statusCode).toBe(401);
    expect(outside.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Requête refusée' } });
    expect((await callHook(payload, { ip: '2001:db8:2::1' })).statusCode).toBe(401);
    expect(countOrders()).toBe(before);

    expect((await callHook(basePayload(), { ip: '2001:db8:1::25' })).statusCode).toBe(200);
    // IPv4 mappée en IPv6 : reconnue comme l'IPv4 autorisée.
    expect((await callHook(basePayload(), { ip: '::ffff:203.0.113.200' })).statusCode).toBe(200);
  });

  it('refuse un corps trop gros sans rien créer', async () => {
    const before = countOrders();
    const huge = basePayload({ products: Array.from({ length: 50 }, () => 'x'.repeat(200)), clientName: 'y'.repeat(200) });
    const body = JSON.stringify({ ...huge, padding: 'z'.repeat(WEBHOOK_BODY_LIMIT) });
    const res = await callHook(body);
    expect(res.statusCode).toBe(401);
    expect(countOrders()).toBe(before);
  });

  it('limite le débit par appelant', async () => {
    const ip = hookIp();
    const statuses: number[] = [];
    for (let i = 0; i < 62; i += 1) statuses.push((await callHook(basePayload(), { ip, signature: `sha256=${'1'.repeat(64)}` })).statusCode);
    expect(statuses.slice(0, 60).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(60)).toEqual([429, 429]);
    // Un autre appelant n'est pas affecté.
    expect((await callHook(basePayload())).statusCode).toBe(200);
  });

  it('journalise les refus avec modération et alerte une seule fois', async () => {
    const ip = hookIp();
    const auditCount = () => (db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'notifications.webhook.rejected' AND ip = ?").get(ip) as { c: number }).c;
    outbox.length = 0;
    for (let i = 0; i < 5; i += 1) await callHook(basePayload(), { ip, signature: `sha256=${'2'.repeat(64)}` });
    expect(auditCount()).toBe(1);
    await flushAlerts();
    expect(outbox.filter((mail) => mail.subject.includes('Webhook WHMCS')).length).toBe(1);
    // Ni le secret ni la signature ne sont journalisés.
    const row = db.prepare("SELECT details FROM audit_log WHERE action = 'notifications.webhook.rejected' AND ip = ?").get(ip) as { details: string };
    expect(JSON.parse(row.details)).toEqual({ reason: 'signature', sinceLastEntry: 0 });
    expect(JSON.stringify(outbox)).not.toContain(HOOK_SECRET);

    // Une requête sans en-tête de signature (balayage d'Internet) est journalisée mais n'alerte pas.
    outbox.length = 0;
    resetAlertThrottle();
    await callHook(basePayload(), { omit: ['signature'] });
    await flushAlerts();
    expect(outbox.length).toBe(0);
  });

  it('la route exige POST : les autres méthodes ne sont pas publiques', async () => {
    const res = await app.inject({ method: 'GET', url: WEBHOOK, remoteAddress: hookIp() });
    expect(res.statusCode).toBe(401);
  });

  it('l’analyseur de corps brut reste confiné au webhook', async () => {
    const res = await aliceBrowser.post<{ body: unknown }>('/api/test/mutate', { bonjour: 'monde' });
    expect(res.status).toBe(200);
    expect(res.body.data.body).toEqual({ bonjour: 'monde' });
  });
});

describe('webhook WHMCS — contenu', () => {
  it('crée une notification « order » avec le compte qui encaisse (passerelle insensible à la casse)', async () => {
    setNotificationSettings({ gatewayAccounts: { Stripe: 'Stripe TalCloud', paypal: 'PayPal perso' } });
    const payload = basePayload({ gateway: 'STRIPE' });
    const events: BusMessage[] = [];
    const { subscribe } = await import('../src/core/events.js');
    const unsubscribe = subscribe((message) => events.push(message));
    expect((await callHook(payload)).statusCode).toBe(200);
    unsubscribe();

    const row = notificationsOf('order').at(-1)!;
    expect(row.title).toBe('Nouvelle commande — Jean Dupont');
    expect(row.body).toBe('Minecraft 8 Go · 12,00\u00a0€ · Stripe → Stripe TalCloud');
    expect(row.user_id).toBeNull();
    const data = JSON.parse(row.data!) as OrderNotificationData;
    expect(data).toEqual({
      event: 'order_created',
      orderId: payload.orderId,
      invoiceId: payload.invoiceId,
      clientId: 42,
      clientName: 'Jean Dupont',
      clientEmail: 'jean.dupont@exemple.test',
      products: ['Minecraft 8 Go'],
      amount: 12,
      currency: 'EUR',
      gateway: 'STRIPE',
      gatewayName: 'Stripe',
      receivingAccount: 'Stripe TalCloud',
    });

    // Diffusée en temps réel aux deux administrateurs (pas de userId), non lue.
    expect(events.length).toBe(1);
    expect(events[0]!.userId).toBeUndefined();
    const event = events[0]!.event as Extract<ServerEvent, { type: 'notification' }>;
    expect(event.type).toBe('notification');
    expect(event.notification).toMatchObject({ id: row.id, type: 'order', severity: 'info', read: false, title: row.title });
  });

  it('crée une notification « payment » pour invoice_paid et order_paid ; receivingAccount null si passerelle inconnue', async () => {
    setNotificationSettings({ gatewayAccounts: { stripe: 'Stripe TalCloud' } });
    await callHook(basePayload({ eventId: 'invoice_paid:501', event: 'invoice_paid', gateway: 'banktransfer', gatewayName: 'Virement bancaire', transactionId: 'TX-99', amount: 1234.5 }));
    await callHook(basePayload({ eventId: 'order_paid:502', event: 'order_paid', gateway: undefined, gatewayName: undefined, products: ['A', 'B', 'C', 'D', 'E'] }));

    const [paid, orderPaid] = notificationsOf('payment').slice(-2);
    expect(paid!.title).toBe('Paiement reçu — Jean Dupont');
    expect(paid!.body).toBe('Minecraft 8 Go · 1\u00a0234,50\u00a0€ · Virement bancaire');
    const data = JSON.parse(paid!.data!) as OrderNotificationData;
    expect(data.receivingAccount).toBeNull();
    expect(data.transactionId).toBe('TX-99');
    expect(data.event).toBe('invoice_paid');

    expect(orderPaid!.title).toBe('Commande payée — Jean Dupont');
    expect(orderPaid!.body).toBe('A, B, C, +2 · 12,00\u00a0€');
    expect(JSON.parse(orderPaid!.data!)).toMatchObject({ gateway: null, gatewayName: null, receivingAccount: null });
  });

  it('rejeu : un évènement déjà vu répond 200 sans rien recréer', async () => {
    const payload = basePayload();
    const before = countOrders();
    expect((await callHook(payload)).statusCode).toBe(200);
    expect(countOrders()).toBe(before + 1);
    fetchMock.mockClear();

    // Rejeu à l'identique, puis même eventId re-signé avec un nouvel horodatage et un contenu différent.
    const replay = await callHook(payload);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ data: { received: true } });
    advance(2000);
    expect((await callHook({ ...payload, amount: 999 })).statusCode).toBe(200);
    expect(countOrders()).toBe(before + 1);
    await flushNotifications();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('respecte notifyOrders / notifyPayments', async () => {
    const before = countOrders();
    setNotificationSettings({ notifyOrders: false });
    expect((await callHook(basePayload())).statusCode).toBe(200);
    expect(countOrders()).toBe(before);
    expect((await callHook(basePayload({ eventId: 'invoice_paid:601', event: 'invoice_paid' }))).statusCode).toBe(200);
    expect(countOrders()).toBe(before + 1);

    setNotificationSettings({ notifyPayments: false });
    expect((await callHook(basePayload({ eventId: 'invoice_paid:602', event: 'invoice_paid' }))).statusCode).toBe(200);
    expect(countOrders()).toBe(before + 1);
    expect((await callHook(basePayload())).statusCode).toBe(200);
    expect(countOrders()).toBe(before + 2);
  });

  it('validation stricte : champ inconnu, type faux, chaîne trop longue, évènement inconnu → 400 sans notification', async () => {
    const before = countOrders();
    const invalid: unknown[] = [
      { ...basePayload(), admin: true },
      { ...basePayload(), amount: '12' },
      { ...basePayload(), amount: -1 },
      { ...basePayload(), clientName: 'x'.repeat(201) },
      { ...basePayload(), clientName: '' },
      { ...basePayload(), products: Array.from({ length: 51 }, () => 'p') },
      { ...basePayload(), products: 'Minecraft' },
      { ...basePayload(), event: 'order_deleted' },
      { ...basePayload(), eventId: 'a b' },
      { ...basePayload(), eventId: 'x'.repeat(129) },
      { ...basePayload(), orderId: 1.5 },
      { ...basePayload(), currency: 'EUR €' },
      { ...basePayload(), gateway: null },
      [basePayload()],
      null,
    ];
    for (const payload of invalid) {
      const res = await callHook(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'Charge utile invalide' } });
    }
    expect(countOrders()).toBe(before);
  });

  it('stocke les données non fiables telles quelles, sans les interpréter', async () => {
    const nasty = '<img src=x onerror=alert(1)> \'; DROP TABLE notifications;-- {{7*7}}';
    expect((await callHook(basePayload({ clientName: nasty, products: ['<script>alert(1)</script>'] }))).statusCode).toBe(200);
    const row = notificationsOf('order').at(-1)!;
    const data = JSON.parse(row.data!) as OrderNotificationData;
    expect(data.clientName).toBe(nasty);
    expect(data.products).toEqual(['<script>alert(1)</script>']);
    expect(row.title).toBe(`Nouvelle commande — ${nasty}`);
    // Un nom contenant des sauts de ligne ne peut pas fabriquer de fausses lignes dans le titre.
    await callHook(basePayload({ clientName: 'Jean\r\nDupont\u202e' }));
    expect(notificationsOf('order').at(-1)!.title).toBe('Nouvelle commande — Jean Dupont');
  });

  it('purge les anciens identifiants d’évènements', async () => {
    const payload = basePayload();
    await callHook(payload);
    const exists = () => db.prepare('SELECT 1 FROM webhook_events WHERE event_id = ?').get(payload.eventId) !== undefined;
    // Conservé tant que la durée de rétention n'est pas écoulée (un rejeu reste donc sans effet).
    purgeWebhookEvents(Date.now() + WEBHOOK_EVENT_RETENTION_MS - 1000);
    expect(exists()).toBe(true);
    expect(purgeWebhookEvents(Date.now() + WEBHOOK_EVENT_RETENTION_MS + 1000)).toBeGreaterThan(0);
    expect(exists()).toBe(false);
  });
});

describe('Discord', () => {
  it('n’accepte qu’une URL de webhook Discord (protection SSRF)', () => {
    expect(parseDiscordWebhookUrl(DISCORD_URL)).toBe(DISCORD_URL);
    expect(parseDiscordWebhookUrl(DISCORD_URL.replace('discord.com', 'discordapp.com'))).toBe(DISCORD_URL.replace('discord.com', 'discordapp.com'));
    expect(parseDiscordWebhookUrl(DISCORD_URL.replace('/api/', '/api/v10/'))).toBe(DISCORD_URL.replace('/api/', '/api/v10/'));
    // La chaîne de requête est retirée.
    expect(parseDiscordWebhookUrl(`${DISCORD_URL}?wait=true`)).toBe(DISCORD_URL);

    const path = DISCORD_URL.slice('https://discord.com'.length);
    const refused = [
      DISCORD_URL.replace('https://', 'http://'),
      `https://discord.com.evil.test${path}`,
      `https://evil.test${path}`,
      `https://evildiscord.com${path}`,
      `https://discord.com@evil.test${path}`,
      `https://user:pass@discord.com${path}`,
      `https://discord.com:8443${path}`,
      `https://discord.com\\@evil.test${path}`,
      `https://127.0.0.1${path}`,
      `https://[::1]${path}`,
      'https://discord.com/api/webhooks/123456789012345678',
      'https://discord.com/api/users/@me',
      'https://discord.com/api/webhooks/../../../etc/passwd',
      `https://discord.com/redirect?to=${encodeURIComponent(DISCORD_URL)}`,
      'https://localhost/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz',
      `${DISCORD_URL}\nHost: evil.test`,
      'javascript:alert(1)',
      'file:///etc/passwd',
      '',
      null,
      42,
    ];
    for (const value of refused) expect(parseDiscordWebhookUrl(value), String(value)).toBeNull();
  });

  it('réglages : URL validée, jamais renvoyée, modification sous step-up', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.login(alice);
    setSettings('notifications', {}, null);

    // Sans step-up (la fenêtre ouverte par la connexion est écoulée) : refus.
    advance(6 * 60_000);
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE revoked_at IS NULL').run(Date.now());
    expect((await browser.put('/api/settings/notifications', { discordEnabled: true })).errorCode).toBe('STEP_UP_REQUIRED');
    expect((await browser.stepUp(alice)).status).toBe(200);

    for (const url of ['https://evil.test/api/webhooks/1/x', 'http://169.254.169.254/latest/meta-data', DISCORD_URL.replace('https', 'http')]) {
      const bad = await browser.put('/api/settings/notifications', { discordWebhookUrl: url });
      expect(bad.status).toBe(400);
    }
    expect(getSettings<Record<string, unknown>>('notifications')?.discordWebhookUrl).toBeUndefined();
    // Champ inconnu ou comptes mal formés : refus.
    expect((await browser.put('/api/settings/notifications', { inconnu: 1 })).status).toBe(400);
    expect((await browser.put('/api/settings/notifications', { gatewayAccounts: { stripe: 12 } })).status).toBe(400);

    const saved = await browser.put<SettingsView<Record<string, unknown>>>('/api/settings/notifications', {
      discordEnabled: true,
      discordWebhookUrl: `${DISCORD_URL}?wait=true`,
      gatewayAccounts: { stripe: 'Stripe TalCloud' },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({
      configured: true,
      values: { discordEnabled: true, notifyOrders: true, notifyPayments: true, gatewayAccounts: { stripe: 'Stripe TalCloud' } },
      secrets: { discordWebhookUrl: true },
    });
    expect(JSON.stringify(saved.body)).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(getSettings<Record<string, unknown>>('notifications')?.discordWebhookUrl).toBe(DISCORD_URL);

    const view = await browser.get<SettingsView<Record<string, unknown>>>('/api/settings/notifications');
    expect(JSON.stringify(view.body)).not.toContain('/api/webhooks/');

    // Test : un message d'essai part vers l'URL enregistrée.
    fetchMock.mockClear();
    const test = await browser.post<SettingsTestResult>('/api/settings/notifications/test');
    expect(test.body.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toBe(DISCORD_URL);

    // Échec distant : message générique, sans l'URL.
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 404, body: null }));
    const failed = await browser.post<SettingsTestResult>('/api/settings/notifications/test');
    expect(failed.body.data.ok).toBe(false);
    expect(JSON.stringify(failed.body)).not.toContain('discord.com');
  });

  it('envoie un embed sans mention possible ni mise en forme injectée', async () => {
    setNotificationSettings({ discordEnabled: true, discordWebhookUrl: DISCORD_URL, gatewayAccounts: { stripe: 'Stripe TalCloud' } });
    const evil = '@everyone <@&123> **gras** [clic](https://evil.test) `code` ||spoiler|| https://evil.test\n# Titre';
    await callHook(basePayload({ clientName: evil, products: ['Minecraft 8 Go', '~~barré~~ > citation'] }));
    await flushNotifications();

    const discordCalls = fetchMock.mock.calls.filter((call) => call[1] === DISCORD_URL);
    expect(discordCalls.length).toBe(1);
    const options = discordCalls[0]![2] as { method: string; body: string };
    expect(options.method).toBe('POST');
    const message = JSON.parse(options.body) as { content?: string; allowed_mentions: unknown; embeds: { title: string; fields: { name: string; value: string }[] }[] };
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.content).toBeUndefined();

    const embed = message.embeds[0]!;
    const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));
    expect(Object.keys(fields)).toEqual(['Client', 'Montant', 'Produits', 'Moyen de paiement', 'Compte', 'Références']);
    // Les espaces (insécables compris) sont normalisés dans le texte envoyé à Discord.
    expect(fields.Montant).toMatch(/^12,00 €$/);
    expect(fields['Moyen de paiement']).toBe('Stripe');
    expect(fields.Compte).toBe('Stripe TalCloud');

    for (const text of [embed.title, fields.Client!, fields.Produits!]) {
      expect(text).not.toContain('@everyone');
      expect(text).not.toContain('<@');
      expect(text).not.toContain('://');
      expect(text).not.toContain('\n');
      // Tout caractère de mise en forme est précédé d'un antislash.
      expect(text).not.toMatch(/(?<!\\)[*_~`|>#[\]()<]/);
    }
    // L'adresse e-mail du client ne part pas sur Discord.
    expect(options.body).not.toContain('jean.dupont@exemple.test');
  });

  it('discordText : longueur bornée après échappement, sans antislash orphelin', () => {
    const text = discordText('*'.repeat(500), 100);
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text.endsWith('…')).toBe(true);
    expect((/\\+…$/.exec(text)?.[0].length ?? 1) % 2).toBe(1);
    expect(discordText('a\\', 50)).toBe('a\\\\');
    expect(discordText(null, 10)).toBe('');
    expect(buildDiscordMessage({ id: 1, type: 'system', severity: 'warning', title: 'T', body: '@here', data: null, createdAt: new Date().toISOString(), read: false }).embeds[0]!.description).toBe('\\@\u200bhere');
  });

  it('n’envoie rien si Discord est désactivé ou sans URL', async () => {
    setNotificationSettings({ discordEnabled: false, discordWebhookUrl: DISCORD_URL });
    await callHook(basePayload());
    setNotificationSettings({ discordEnabled: true });
    await callHook(basePayload());
    await flushNotifications();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('notify()', () => {
  it('ne lève jamais : Discord et push en échec, données invalides', async () => {
    setNotificationSettings({ discordEnabled: true, discordWebhookUrl: DISCORD_URL });
    const browser = new Browser(app, uniqueIp());
    await browser.login(alice);
    await subscribePush(browser, 'https://fcm.googleapis.com/fcm/send/echec');
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => {
      throw upstream('notifications', 'Impossible de contacter notifications');
    });

    const before = notificationsOf('system').length;
    await expect(notify({ type: 'system', title: 'Réseau en panne', body: 'corps', channels: { discord: true, push: true } })).resolves.toBeUndefined();
    await expect(flushNotifications()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // La notification existe malgré l'échec des canaux externes.
    expect(notificationsOf('system').length).toBe(before + 1);

    // Erreur non normalisée (TypeError…) : toujours pas d'exception.
    fetchMock.mockImplementation(() => {
      throw new TypeError('boum');
    });
    await expect(notify({ type: 'system', title: 't', body: 'b', channels: { discord: true, push: true } })).resolves.toBeUndefined();
    await flushNotifications();

    // Entrées refusées par la base (type inconnu, compte inexistant) ou non sérialisables : pas d'exception non plus.
    await expect(notify({ type: 'inconnu' as never, title: 't', body: 'b' })).resolves.toBeUndefined();
    await expect(notify({ type: 'system', title: 't', body: 'b', userId: 987654 })).resolves.toBeUndefined();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(notify({ type: 'system', title: 't', body: 'b', data: circular })).resolves.toBeUndefined();
    await expect(notify({ type: 'system', title: undefined as never, body: null as never })).resolves.toBeUndefined();

    db.prepare('DELETE FROM push_subscriptions').run();
  });

  it('ne bloque pas l’appelant sur le réseau', async () => {
    setNotificationSettings({ discordEnabled: true, discordWebhookUrl: DISCORD_URL });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fetchMock.mockImplementation(async () => {
      await gate;
      return okResponse();
    });
    // notify() rend la main alors que Discord n'a pas encore répondu.
    await notify({ type: 'system', title: 'Sans attente', body: 'b', channels: { discord: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notificationsOf('system').at(-1)!.title).toBe('Sans attente');
    release();
    await flushNotifications();
  });

  it('borne le titre et le corps, et cible un seul compte avec userId', async () => {
    const events: BusMessage[] = [];
    const { subscribe } = await import('../src/core/events.js');
    const unsubscribe = subscribe((message) => events.push(message));
    await notify({ type: 'system', severity: 'critical', title: 'T'.repeat(500), body: 'B'.repeat(5000), userId: alice.user.id, data: { a: 1 } });
    unsubscribe();
    const row = notificationsOf('system').at(-1)!;
    expect(row.title.length).toBe(200);
    expect(row.body.length).toBe(2000);
    expect(row.user_id).toBe(alice.user.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.userId).toBe(alice.user.id);
  });
});

describe('centre de notifications', () => {
  it('exige une session', async () => {
    const anonymous = new Browser(app, uniqueIp());
    expect((await anonymous.get('/api/notifications')).status).toBe(401);
    expect((await anonymous.get('/api/notifications/unread-count')).status).toBe(401);
    expect((await anonymous.get('/api/events')).status).toBe(401);
    expect((await anonymous.get('/api/push/public-key')).status).toBe(401);
    expect((await anonymous.post('/api/notifications/read-all')).status).toBe(401);
  });

  it('l’état « lu » est propre à chaque administrateur', async () => {
    await aliceBrowser.post('/api/notifications/read-all');
    await bobBrowser.post('/api/notifications/read-all');
    await notify({ type: 'system', title: 'Commune', body: 'pour les deux' });
    const id = notificationsOf('system').at(-1)!.id;

    expect((await aliceBrowser.get<UnreadCount>('/api/notifications/unread-count')).body.data).toEqual({ count: 1 });
    expect((await bobBrowser.get<UnreadCount>('/api/notifications/unread-count')).body.data).toEqual({ count: 1 });

    const read = await aliceBrowser.post(`/api/notifications/${id}/read`);
    expect(read.status).toBe(200);
    // Idempotent.
    expect((await aliceBrowser.post(`/api/notifications/${id}/read`)).status).toBe(200);

    const aliceList = await aliceBrowser.get<PanelNotification[]>('/api/notifications?pageSize=5');
    const bobList = await bobBrowser.get<PanelNotification[]>('/api/notifications?pageSize=5');
    expect(aliceList.body.data.find((n) => n.id === id)!.read).toBe(true);
    expect(bobList.body.data.find((n) => n.id === id)!.read).toBe(false);
    expect((await aliceBrowser.get<UnreadCount>('/api/notifications/unread-count')).body.data.count).toBe(0);
    expect((await bobBrowser.get<UnreadCount>('/api/notifications/unread-count')).body.data.count).toBe(1);

    // Filtre « non lues ».
    expect((await aliceBrowser.get<PanelNotification[]>('/api/notifications?unread=1')).body.data).toEqual([]);
    expect((await bobBrowser.get<PanelNotification[]>('/api/notifications?unread=1')).body.data.map((n) => n.id)).toEqual([id]);
  });

  it('une notification ciblée n’est visible, comptée et marquable que par son destinataire', async () => {
    await notify({ type: 'security', severity: 'warning', title: 'Privée', body: 'pour alice', userId: alice.user.id });
    const id = notificationsOf('security').at(-1)!.id;

    const aliceIds = (await aliceBrowser.get<PanelNotification[]>('/api/notifications?type=security&pageSize=100')).body.data.map((n) => n.id);
    const bobIds = (await bobBrowser.get<PanelNotification[]>('/api/notifications?type=security&pageSize=100')).body.data.map((n) => n.id);
    expect(aliceIds).toContain(id);
    expect(bobIds).not.toContain(id);

    const bobBefore = (await bobBrowser.get<UnreadCount>('/api/notifications/unread-count')).body.data.count;
    const refused = await bobBrowser.post(`/api/notifications/${id}/read`);
    expect(refused.status).toBe(404);
    expect(db.prepare('SELECT 1 FROM notification_reads WHERE notification_id = ? AND user_id = ?').get(id, bob.user.id)).toBeUndefined();
    expect((await bobBrowser.get<UnreadCount>('/api/notifications/unread-count')).body.data.count).toBe(bobBefore);

    // « Tout marquer comme lu » de bob ne touche pas la notification privée d'alice.
    await bobBrowser.post('/api/notifications/read-all');
    expect(db.prepare('SELECT 1 FROM notification_reads WHERE notification_id = ?').get(id)).toBeUndefined();
    expect((await aliceBrowser.get<PanelNotification[]>('/api/notifications?unread=1&type=security')).body.data.map((n) => n.id)).toContain(id);
  });

  it('pagination, filtre par type, forme exacte et validation des paramètres', async () => {
    await aliceBrowser.post('/api/notifications/read-all');
    for (let i = 1; i <= 5; i += 1) await notify({ type: 'system', title: `Page ${i}`, body: 'b', data: { index: i } });

    const first = await aliceBrowser.get<PanelNotification[]>('/api/notifications?type=system&unread=1&page=1&pageSize=2');
    expect(first.status).toBe(200);
    expect(first.body.meta).toEqual({ page: 1, pageSize: 2, total: 5 });
    expect(first.body.data.map((n) => n.title)).toEqual(['Page 5', 'Page 4']);
    const third = await aliceBrowser.get<PanelNotification[]>('/api/notifications?type=system&unread=1&page=3&pageSize=2');
    expect(third.body.data.map((n) => n.title)).toEqual(['Page 1']);

    const item = first.body.data[0]!;
    expect(Object.keys(item).sort()).toEqual(['body', 'createdAt', 'data', 'id', 'read', 'severity', 'title', 'type']);
    expect(item).toMatchObject({ type: 'system', severity: 'info', data: { index: 5 }, read: false });
    expect(new Date(item.createdAt).toISOString()).toBe(item.createdAt);

    expect((await aliceBrowser.get<PanelNotification[]>('/api/notifications?type=order&pageSize=100')).body.data.every((n) => n.type === 'order')).toBe(true);

    for (const query of ['page=0', 'pageSize=101', 'type=autre', 'unread=oui', 'page=abc']) {
      expect((await aliceBrowser.get(`/api/notifications?${query}`)).status, query).toBe(400);
    }
    for (const id of ['abc', '0', '-1', '1.5', '1%20OR%201=1']) {
      expect((await aliceBrowser.post(`/api/notifications/${id}/read`)).status, id).toBe(400);
    }
    expect((await aliceBrowser.post('/api/notifications/99999999/read')).status).toBe(404);

    // Les écritures exigent le jeton CSRF.
    expect((await aliceBrowser.post('/api/notifications/read-all', {}, { csrf: null })).errorCode).toBe('CSRF_INVALID');

    const all = await aliceBrowser.post<{ marked: number }>('/api/notifications/read-all');
    expect(all.body.data.marked).toBe(5);
    expect((await aliceBrowser.get<UnreadCount>('/api/notifications/unread-count')).body.data.count).toBe(0);
  });

  it('unread-count ne prolonge pas la session (route d’arrière-plan)', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.login(alice);
    const lastSeen = () => (db.prepare('SELECT last_seen_at FROM sessions WHERE ip = ? ORDER BY created_at DESC').get(browser.ip) as { last_seen_at: number }).last_seen_at;
    const before = lastSeen();
    advance(30_000);
    expect((await browser.get('/api/notifications/unread-count')).status).toBe(200);
    expect(lastSeen()).toBe(before);
    expect((await browser.get('/api/notifications')).status).toBe(200);
    expect(lastSeen()).toBeGreaterThan(before);
  });

  it('purge les très anciennes notifications', async () => {
    await notify({ type: 'system', title: 'Ancienne', body: 'b' });
    const id = notificationsOf('system').at(-1)!.id;
    db.prepare('UPDATE notifications SET created_at = ? WHERE id = ?').run(Date.now() - 181 * 24 * 3600_000, id);
    await notify({ type: 'system', title: 'Récente', body: 'b' });
    const recent = notificationsOf('system').at(-1)!.id;
    expect(purgeNotifications()).toBe(1);
    expect(db.prepare('SELECT 1 FROM notifications WHERE id = ?').get(id)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM notifications WHERE id = ?').get(recent)).toBeDefined();
  });
});

function pushKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

async function subscribePush(browser: Browser, endpoint: string, keys = pushKeys()) {
  const res = await browser.post('/api/push/subscribe', { endpoint, expirationTime: null, keys });
  expect(res.status).toBe(200);
  return keys;
}

describe('push navigateur', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM push_subscriptions').run();
  });

  it('clé publique VAPID stable ; la clé privée n’est jamais exposée', async () => {
    const first = await aliceBrowser.get<PushPublicKey>('/api/push/public-key');
    const second = await bobBrowser.get<PushPublicKey>('/api/push/public-key');
    expect(first.status).toBe(200);
    expect(Buffer.from(first.body.data.publicKey, 'base64url').length).toBe(65);
    expect(second.body.data.publicKey).toBe(first.body.data.publicKey);
    expect(Object.keys(first.body.data)).toEqual(['publicKey']);

    // Stockée chiffrée dans un espace interne, qu'aucune route de réglages n'expose.
    const stored = getSettings<{ publicKey: string; privateKey: string }>('notifications.vapid')!;
    expect(stored.publicKey).toBe(first.body.data.publicKey);
    const raw = (db.prepare("SELECT data_enc FROM integration_settings WHERE namespace = 'notifications.vapid'").get() as { data_enc: string }).data_enc;
    expect(raw).not.toContain(stored.privateKey);
    expect((await aliceBrowser.get('/api/settings/notifications.vapid')).status).toBe(404);
    expect(JSON.stringify((await aliceBrowser.get('/api/settings/notifications')).body)).not.toContain(stored.privateKey);
  });

  it('abonnement : rattaché à l’utilisateur courant, clés chiffrées en base, point de terminaison validé', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/dEvIcE-1:APA91b';
    const keys = await subscribePush(aliceBrowser, endpoint);
    const row = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as { user_id: number; keys_enc: string; user_agent: string };
    expect(row.user_id).toBe(alice.user.id);
    expect(row.user_agent).toBe(CHROME_UA);
    expect(row.keys_enc.startsWith('v1:')).toBe(true);
    expect(row.keys_enc).not.toContain(keys.p256dh);
    expect(row.keys_enc).not.toContain(keys.auth);

    // Réabonnement du même navigateur : pas de doublon.
    await subscribePush(aliceBrowser, endpoint);
    expect((db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions').get() as { c: number }).c).toBe(1);

    const valid = pushKeys();
    const refused: Record<string, unknown>[] = [
      { endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys: valid },
      { endpoint: 'https://evil.test/push', keys: valid },
      { endpoint: 'https://127.0.0.1/push', keys: valid },
      { endpoint: 'https://localhost:8080/push', keys: valid },
      { endpoint: 'https://fcm.googleapis.com.evil.test/x', keys: valid },
      { endpoint: 'https://user:pw@fcm.googleapis.com/x', keys: valid },
      { endpoint: 'https://fcm.googleapis.com:8443/x', keys: valid },
      { endpoint: 'pas une url', keys: valid },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: valid.p256dh, auth: 'trop-court' } },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'AAAA', auth: valid.auth } },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: valid.p256dh } },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: valid, userId: bob.user.id },
      { keys: valid },
    ];
    for (const body of refused) expect((await aliceBrowser.post('/api/push/subscribe', body)).status, JSON.stringify(body.endpoint)).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions').get() as { c: number }).c).toBe(1);

    expect(parsePushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).not.toBeNull();
    expect(parsePushEndpoint('https://db5p.notify.windows.com/w/?token=abc')).not.toBeNull();
    expect(parsePushEndpoint('https://web.push.apple.com/abc')).not.toBeNull();
    expect(parsePushEndpoint('https://push.services.mozilla.com.evil.test/x')).toBeNull();
    expect(parsePushEndpoint('https://.push.apple.com/x')).toBeNull();
  });

  it('désabonnement : seulement ses propres abonnements', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/alice-device';
    await subscribePush(aliceBrowser, endpoint);
    const byBob = await bobBrowser.post<{ removed: boolean }>('/api/push/unsubscribe', { endpoint });
    expect(byBob.status).toBe(200);
    expect(byBob.body.data.removed).toBe(false);
    expect(db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ?').get(endpoint)).toBeDefined();
    const byAlice = await aliceBrowser.post<{ removed: boolean }>('/api/push/unsubscribe', { endpoint });
    expect(byAlice.body.data.removed).toBe(true);
    expect(db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ?').get(endpoint)).toBeUndefined();
  });

  it('envoi : charge utile chiffrée vers le bon destinataire, abonnements expirés supprimés', async () => {
    const aliceEndpoint = 'https://fcm.googleapis.com/fcm/send/alice';
    const bobEndpoint = 'https://updates.push.services.mozilla.com/wpush/v2/bob';
    const goneEndpoint = 'https://fcm.googleapis.com/fcm/send/expire';
    await subscribePush(aliceBrowser, aliceEndpoint);
    await subscribePush(bobBrowser, bobEndpoint);
    await subscribePush(bobBrowser, goneEndpoint);
    fetchMock.mockImplementation(async (_integration: string, url: string) => (url === goneEndpoint ? { ok: false, status: 410, body: null } : { ok: true, status: 201, body: null }));

    // Notification commune : les trois abonnements sont sollicités.
    await notify({ type: 'system', title: 'Titre très secret', body: 'Corps', channels: { push: true } });
    await flushNotifications();
    const urls = fetchMock.mock.calls.map((call) => call[1] as string).sort();
    expect(urls).toEqual([aliceEndpoint, goneEndpoint, bobEndpoint].sort());
    // 410 Gone : abonnement supprimé.
    expect(db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ?').get(goneEndpoint)).toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions').get() as { c: number }).c).toBe(2);

    const options = fetchMock.mock.calls[0]![2] as { method: string; headers: Record<string, string>; body: Buffer };
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(options.headers['Content-Encoding']).toBe('aes128gcm');
    expect(String(options.headers.TTL)).toBe('86400');
    // La charge utile part chiffrée : le service push ne lit pas le titre.
    expect(Buffer.isBuffer(options.body)).toBe(true);
    expect(options.body.toString('latin1')).not.toContain('Titre');

    // Notification ciblée : seul l'abonnement du destinataire.
    fetchMock.mockClear();
    await notify({ type: 'system', title: 'Pour bob', body: 'b', userId: bob.user.id, channels: { push: true } });
    await flushNotifications();
    expect(fetchMock.mock.calls.map((call) => call[1])).toEqual([bobEndpoint]);

    // Sans le canal push : rien ne part.
    fetchMock.mockClear();
    await notify({ type: 'system', title: 'Silencieuse', body: 'b' });
    await flushNotifications();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /api/push/test : envoie aux appareils du compte courant', async () => {
    const none = await aliceBrowser.post<SettingsTestResult>('/api/push/test');
    expect(none.body.data.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    await subscribePush(aliceBrowser, 'https://fcm.googleapis.com/fcm/send/alice-test');
    await subscribePush(bobBrowser, 'https://fcm.googleapis.com/fcm/send/bob-test');
    const sent = await aliceBrowser.post<SettingsTestResult>('/api/push/test');
    expect(sent.body.data).toEqual({ ok: true, message: 'Notification d’essai envoyée à 1 appareil(s)' });
    expect(fetchMock.mock.calls.map((call) => call[1])).toEqual(['https://fcm.googleapis.com/fcm/send/alice-test']);

    fetchMock.mockImplementation(async () => ({ ok: false, status: 404, body: null }));
    const expired = await aliceBrowser.post<SettingsTestResult>('/api/push/test');
    expect(expired.body.data.ok).toBe(false);
    expect(db.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint LIKE '%alice-test'").get()).toBeUndefined();
  });
});

/** Lit les messages `data:` d'un flux SSE au fur et à mesure. */
function sseReader(stream: Readable) {
  let buffer = '';
  let ended = false;
  const waiters: (() => void)[] = [];
  const wake = () => waiters.splice(0).forEach((resolve) => resolve());
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    wake();
  });
  stream.on('end', () => {
    ended = true;
    wake();
  });
  stream.on('close', () => {
    ended = true;
    wake();
  });
  return {
    get raw() {
      return buffer;
    },
    get ended() {
      return ended;
    },
    events(): ServerEvent[] {
      return buffer
        .split('\n\n')
        .filter((block) => block.startsWith('data: '))
        .map((block) => JSON.parse(block.slice(6)) as ServerEvent);
    },
    async until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
      const deadline = performance.now() + timeoutMs;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error(`flux SSE : condition non atteinte (reçu : ${JSON.stringify(buffer)})`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

const notificationEvent = (id: number): BusMessage['event'] => ({
  type: 'notification',
  notification: { id, type: 'system', severity: 'info', title: `n${id}`, body: '', data: null, createdAt: new Date().toISOString(), read: false },
});

describe('flux SSE', () => {
  it('shouldDeliver : filtrage par utilisateur et par session', () => {
    const target = { userId: 1, sessionId: 'session-a' };
    expect(shouldDeliver({ event: { type: 'ping' } }, target)).toBe(true);
    expect(shouldDeliver({ event: notificationEvent(1), userId: 1 }, target)).toBe(true);
    expect(shouldDeliver({ event: notificationEvent(1), userId: 2 }, target)).toBe(false);
    expect(shouldDeliver({ event: { type: 'session_revoked' }, userId: 1, sessionId: 'session-a' }, target)).toBe(true);
    expect(shouldDeliver({ event: { type: 'session_revoked' }, userId: 1, sessionId: 'session-b' }, target)).toBe(false);
    expect(shouldDeliver({ event: { type: 'session_revoked' }, userId: 2, sessionId: 'session-a' }, target)).toBe(false);
    expect(shouldDeliver({ event: { type: 'session_revoked' }, sessionId: 'session-b' }, target)).toBe(false);
  });

  it('EventStream : ne transmet que les messages destinés à sa session, puis se désabonne', async () => {
    const mine = new EventStream({ userId: 101, sessionId: 's-1' }, { isSessionValid: () => true });
    const other = new EventStream({ userId: 102, sessionId: 's-2' }, { isSessionValid: () => true });
    const mineReader = sseReader(mine.stream);
    const otherReader = sseReader(other.stream);

    publish({ event: notificationEvent(1) });
    publish({ event: notificationEvent(2), userId: 101 });
    publish({ event: notificationEvent(3), userId: 102 });
    publish({ event: { type: 'session_revoked' }, userId: 101, sessionId: 'une-autre-session' });
    await mineReader.until(() => mineReader.events().length >= 2);
    await otherReader.until(() => otherReader.events().length >= 2);

    const ids = (events: ServerEvent[]) => events.map((event) => (event.type === 'notification' ? event.notification.id : event.type));
    expect(ids(mineReader.events())).toEqual([1, 2]);
    expect(ids(otherReader.events())).toEqual([1, 3]);
    expect(mine.isClosed).toBe(false);
    expect(mineReader.raw.startsWith('retry: 5000\n\n')).toBe(true);

    // Battement : ping tant que la session est valide.
    mine.tick();
    await mineReader.until(() => mineReader.events().length >= 3);
    expect(mineReader.events().at(-1)).toEqual({ type: 'ping' });

    // Révocation de CETTE session : l'évènement est envoyé puis le flux est fermé et désabonné.
    publish({ event: { type: 'session_revoked' }, userId: 101, sessionId: 's-1' });
    await mineReader.until(() => mineReader.ended);
    expect(mineReader.events().at(-1)).toEqual({ type: 'session_revoked' });
    expect(mine.isClosed).toBe(true);
    expect(openStreamCount(101)).toBe(0);
    publish({ event: notificationEvent(4), userId: 101 });
    expect(ids(mineReader.events())).not.toContain(4);

    other.close();
    other.close();
    expect(openStreamCount(102)).toBe(0);
  });

  it('EventStream : ferme le flux quand la session n’est plus valide à la revalidation', async () => {
    let valid = true;
    const stream = new EventStream({ userId: 103, sessionId: 's-3' }, { isSessionValid: () => valid });
    const reader = sseReader(stream.stream);
    stream.tick();
    valid = false;
    stream.tick();
    await reader.until(() => reader.ended);
    expect(reader.events()).toEqual([{ type: 'ping' }, { type: 'session_revoked' }]);
    expect(stream.isClosed).toBe(true);
    expect(openStreamCount(103)).toBe(0);

    // Une erreur de la vérification vaut session invalide.
    const broken = new EventStream({ userId: 103, sessionId: 's-4' }, {
      isSessionValid: () => {
        throw new Error('base indisponible');
      },
    });
    broken.stream.resume();
    broken.tick();
    expect(broken.isClosed).toBe(true);
  });

  it('plafonne le nombre de connexions par utilisateur', () => {
    const opened = Array.from({ length: MAX_STREAMS_PER_USER }, (_, i) => new EventStream({ userId: 104, sessionId: `s-${i}` }, { isSessionValid: () => true }));
    expect(() => new EventStream({ userId: 104, sessionId: 'de-trop' }, { isSessionValid: () => true })).toThrowError(/Trop de connexions/);
    // Un autre compte n'est pas affecté ; une place libérée est réutilisable.
    const otherUser = new EventStream({ userId: 105, sessionId: 's' }, { isSessionValid: () => true });
    opened[0]!.close();
    const again = new EventStream({ userId: 104, sessionId: 'ok' }, { isSessionValid: () => true });
    for (const stream of [...opened, otherUser, again]) stream.close();
    expect(openStreamCount(104)).toBe(0);
  });

  it('GET /api/events : en-têtes réellement envoyés, messages filtrés, fermeture à la révocation', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.login(alice);
    const session = db.prepare('SELECT id, last_seen_at FROM sessions WHERE ip = ? ORDER BY created_at DESC').get(browser.ip) as { id: string; last_seen_at: number };
    advance(10_000);

    const res = await app.inject({
      method: 'GET',
      url: '/api/events',
      headers: { cookie: [...browser.cookies].map(([name, value]) => `${name}=${value}`).join('; '), 'user-agent': CHROME_UA },
      remoteAddress: browser.ip,
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store, no-transform');
    // Les en-têtes de sécurité posés par les hooks partent bien avec le flux.
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['set-cookie']).toBeUndefined();
    // Le flux ne prolonge pas la session.
    expect((db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').get(session.id) as { last_seen_at: number }).last_seen_at).toBe(session.last_seen_at);
    expect(openStreamCount(alice.user.id)).toBe(1);

    const reader = sseReader(res.stream());
    await notify({ type: 'system', title: 'Pour tous', body: 'b' });
    await notify({ type: 'system', title: 'Pour bob seulement', body: 'b', userId: bob.user.id });
    await notify({ type: 'system', title: 'Pour alice\n\ndata: {"type":"session_revoked"}', body: 'b', userId: alice.user.id });
    await reader.until(() => reader.events().length >= 2);
    const titles = reader.events().map((event) => (event.type === 'notification' ? event.notification.title : event.type));
    // Le contenu non fiable (sauts de ligne) ne peut pas forger un second message.
    expect(titles).toEqual(['Pour tous', 'Pour alice\n\ndata: {"type":"session_revoked"}']);

    // Révocation de la session : évènement puis fin du flux, connexion libérée.
    expect(revokeSession(alice.user.id, session.id)).toBe(true);
    await reader.until(() => reader.ended);
    expect(reader.events().at(-1)).toEqual({ type: 'session_revoked' });
    expect(openStreamCount(alice.user.id)).toBe(0);
  });
});

describe('flux SSE sur une vraie connexion HTTP', () => {
  it('les en-têtes partent immédiatement, la déconnexion du client libère le flux, l’arrêt du serveur n’attend pas', async () => {
    const http = await import('node:http');
    const browser = new Browser(app, uniqueIp());
    await browser.login(bob);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const cookie = [...browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ');

    const open = () =>
      new Promise<{ res: import('node:http').IncomingMessage; req: import('node:http').ClientRequest }>((resolve, reject) => {
        const req = http.get(`${address}/api/events`, { headers: { cookie, 'user-agent': CHROME_UA } }, (res) => resolve({ res, req }));
        req.on('error', reject);
      });

    const first = await open();
    expect(first.res.statusCode).toBe(200);
    expect(first.res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(first.res.headers['cache-control']).toBe('no-store, no-transform');
    expect(first.res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(first.res.headers['x-content-type-options']).toBe('nosniff');
    expect(first.res.headers['x-frame-options']).toBe('DENY');
    expect(first.res.headers['content-length']).toBeUndefined();
    const reader = sseReader(first.res);
    await reader.until(() => reader.raw.includes(': connecté'));
    expect(openStreamCount(bob.user.id)).toBe(1);

    await notify({ type: 'system', title: 'En direct', body: 'b', userId: bob.user.id });
    await reader.until(() => reader.events().length === 1);
    expect(reader.events()[0]).toMatchObject({ type: 'notification', notification: { title: 'En direct', read: false } });

    // Le client coupe : le serveur se désabonne.
    first.req.destroy();
    const deadline = performance.now() + 3000;
    while (openStreamCount(bob.user.id) > 0 && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openStreamCount(bob.user.id)).toBe(0);

    // Sans session : 401 JSON, pas de flux.
    const anonymous = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => http.get(`${address}/api/events`, resolve).on('error', reject));
    expect(anonymous.statusCode).toBe(401);
    anonymous.resume();

    // Un flux encore ouvert n'empêche pas l'arrêt du serveur (fermé par le hook preClose).
    const second = await open();
    const secondReader = sseReader(second.res);
    await secondReader.until(() => secondReader.raw.includes(': connecté'));
    await app.close();
    await secondReader.until(() => secondReader.ended);
    expect(openStreamCount(bob.user.id)).toBe(0);
  });
});
