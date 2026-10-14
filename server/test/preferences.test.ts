import { createECDH, randomBytes } from 'node:crypto';
import type { UserPreferences } from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
// Aucun appel réseau réel : l'envoi push passe par core/http.ts.
vi.mock('../src/core/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/http.js')>()),
  upstreamFetch: fetchMock,
}));

import { db } from '../src/db/index.js';
import { DEFAULT_PREFERENCES } from '../src/modules/notifications/preferences.js';
import { flushNotifications, notify } from '../src/modules/notifications/service.js';
import { advance, Browser, buildTestApp, createTestAdmin, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

let app: FastifyInstance;
let alice: TestAdmin;
let bob: TestAdmin;
let aliceBrowser: Browser;
let bobBrowser: Browser;

const DEFAULTS: UserPreferences = {
  theme: 'dark',
  push: { orders: true, payments: true, security: true, system: true },
  home: { blocks: ['stats', 'revenueChart', 'recentOrders', 'mail', 'offlineServices', 'notifications'] },
  mail: { defaultAccountId: null },
};

const getPrefs = (browser: Browser) => browser.get<UserPreferences>('/api/me/preferences');
const putPrefs = (browser: Browser, body: Record<string, unknown>) => browser.put<UserPreferences>('/api/me/preferences', body);

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

beforeEach(() => {
  advance(61_000);
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE revoked_at IS NULL').run(Date.now());
  db.prepare('DELETE FROM user_preferences').run();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({ ok: true, status: 201, body: null }));
});

afterAll(async () => {
  await app.close();
});

describe('préférences par administrateur', () => {
  it('valeurs par défaut quand rien n’est enregistré', async () => {
    expect(DEFAULT_PREFERENCES).toEqual(DEFAULTS);
    const res = await getPrefs(aliceBrowser);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(DEFAULTS);
  });

  it('exige une session', async () => {
    const anonymous = new Browser(app, uniqueIp());
    expect((await anonymous.get('/api/me/preferences')).status).toBe(401);
    expect((await anonymous.put('/api/me/preferences', { theme: 'light' })).status).toBe(401);
  });

  it('mise à jour partielle : les autres valeurs sont conservées ; pas de step-up ; journalisée sans valeur', async () => {
    // La fenêtre de step-up ouverte par la connexion est écoulée : la route reste accessible.
    advance(6 * 60_000);
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE revoked_at IS NULL').run(Date.now());

    const first = await putPrefs(aliceBrowser, { theme: 'light', push: { orders: false } });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data).toEqual({ ...DEFAULTS, theme: 'light', push: { ...DEFAULTS.push, orders: false } });

    const second = await putPrefs(aliceBrowser, { home: { blocks: ['mail', 'stats'] }, mail: { defaultAccountId: 7 } });
    expect(second.body.data).toEqual({
      theme: 'light',
      push: { ...DEFAULTS.push, orders: false },
      home: { blocks: ['mail', 'stats'] },
      mail: { defaultAccountId: 7 },
    });
    // Corps vide : rien ne change.
    expect((await putPrefs(aliceBrowser, {})).body.data).toEqual(second.body.data);
    // Tous les blocs masqués, boîte par défaut effacée.
    const third = await putPrefs(aliceBrowser, { home: { blocks: [] }, mail: { defaultAccountId: null } });
    expect(third.body.data.home.blocks).toEqual([]);
    expect(third.body.data.mail.defaultAccountId).toBeNull();
    expect((await getPrefs(aliceBrowser)).body.data).toEqual(third.body.data);

    const logged = db.prepare("SELECT details FROM audit_log WHERE action = 'preferences.update' AND user_id = ? AND success = 1 ORDER BY id").all(alice.user.id) as { details: string }[];
    expect(logged.map((row) => JSON.parse(row.details))).toEqual([{ fields: ['theme', 'push'] }, { fields: ['home', 'mail'] }, { fields: [] }, { fields: ['home', 'mail'] }]);
  });

  it('validation stricte : valeurs inconnues, doublons, tableaux trop longs, champs inconnus', async () => {
    const invalid: Record<string, unknown>[] = [
      { theme: 'blue' },
      { theme: null },
      { push: { orders: 'non' } },
      { push: { marketing: true } },
      { push: null },
      { home: { blocks: ['stats', 'inconnu'] } },
      { home: { blocks: ['stats', 'stats'] } },
      { home: { blocks: ['stats', 'revenueChart', 'recentOrders', 'mail', 'offlineServices', 'notifications', 'stats'] } },
      { home: { blocks: 'stats' } },
      { home: {} },
      { home: { blocks: [], extra: 1 } },
      { mail: { defaultAccountId: 0 } },
      { mail: { defaultAccountId: -3 } },
      { mail: { defaultAccountId: 1.5 } },
      { mail: { defaultAccountId: '4' } },
      { mail: {} },
      { userId: bob.user.id },
      { theme: 'light', inconnu: true },
    ];
    for (const body of invalid) {
      const res = await putPrefs(aliceBrowser, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.errorCode).toBe('VALIDATION_ERROR');
    }
    expect(db.prepare('SELECT 1 FROM user_preferences').get()).toBeUndefined();
    const refused = (db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'preferences.update' AND success = 0").get() as { c: number }).c;
    expect(refused).toBeGreaterThanOrEqual(invalid.length);
  });

  it('CSRF exigé sur le PUT', async () => {
    expect((await aliceBrowser.request('PUT', '/api/me/preferences', { body: { theme: 'light' }, csrf: null })).errorCode).toBe('CSRF_INVALID');
    expect((await aliceBrowser.request('PUT', '/api/me/preferences', { body: { theme: 'light' }, origin: 'https://evil.test' })).errorCode).toBe('CSRF_INVALID');
    // Le jeton de l'autre compte ne convient pas.
    expect((await aliceBrowser.request('PUT', '/api/me/preferences', { body: { theme: 'light' }, csrf: bobBrowser.csrfToken })).errorCode).toBe('CSRF_INVALID');
    expect((await getPrefs(aliceBrowser)).body.data.theme).toBe('dark');
  });

  it('isolation : chaque compte ne lit et ne modifie que ses propres préférences', async () => {
    await putPrefs(aliceBrowser, { theme: 'light', home: { blocks: ['notifications'] } });
    await putPrefs(bobBrowser, { theme: 'system', push: { security: false } });
    expect((await getPrefs(aliceBrowser)).body.data).toMatchObject({ theme: 'light', home: { blocks: ['notifications'] }, push: DEFAULTS.push });
    expect((await getPrefs(bobBrowser)).body.data).toMatchObject({ theme: 'system', home: DEFAULTS.home, push: { ...DEFAULTS.push, security: false } });
    // Aucune route ne prend d'identifiant de compte.
    expect((await aliceBrowser.get(`/api/me/preferences/${bob.user.id}`)).status).toBe(404);
    expect((await aliceBrowser.get(`/api/users/${bob.user.id}/preferences`)).status).toBe(404);
    expect((await aliceBrowser.get(`/api/me/preferences?userId=${bob.user.id}`)).body).toMatchObject({ data: { theme: 'light' } });
  });

  it('fusion avec les valeurs par défaut pour toute clé absente ou illisible (compatibilité future)', async () => {
    const store = (data: string) =>
      db.prepare('INSERT INTO user_preferences (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data').run(alice.user.id, data, Date.now());
    store(JSON.stringify({ theme: 'light' }));
    expect((await getPrefs(aliceBrowser)).body.data).toEqual({ ...DEFAULTS, theme: 'light' });
    store(JSON.stringify({ theme: 'violet', push: { orders: false, payments: 'x' }, home: { blocks: ['stats', 'stats'] }, mail: { defaultAccountId: 3 }, futur: 1 }));
    expect((await getPrefs(aliceBrowser)).body.data).toEqual({ ...DEFAULTS, push: { ...DEFAULTS.push, orders: false }, mail: { defaultAccountId: 3 } });
    store('pas du JSON');
    expect((await getPrefs(aliceBrowser)).body.data).toEqual(DEFAULTS);
    // Une mise à jour repart de la fusion et réécrit un document complet.
    expect((await putPrefs(aliceBrowser, { theme: 'system' })).body.data).toEqual({ ...DEFAULTS, theme: 'system' });
  });
});

function pushKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

describe('push filtré selon les préférences de chaque destinataire', () => {
  const aliceEndpoint = 'https://fcm.googleapis.com/fcm/send/alice-prefs';
  const bobEndpoint = 'https://updates.push.services.mozilla.com/wpush/v2/bob-prefs';

  beforeAll(async () => {
    for (const [browser, admin, endpoint] of [
      [aliceBrowser, alice, aliceEndpoint],
      [bobBrowser, bob, bobEndpoint],
    ] as const) {
      expect((await browser.stepUp(admin)).status).toBe(200);
      expect((await browser.post('/api/push/subscribe', { endpoint, keys: pushKeys() })).status).toBe(200);
    }
  });

  const pushedTo = async (input: Parameters<typeof notify>[0]): Promise<string[]> => {
    fetchMock.mockClear();
    await notify({ ...input, channels: { push: true } });
    await flushNotifications();
    return fetchMock.mock.calls.map((call) => call[1] as string).sort();
  };

  it('chaque abonnement ne reçoit que les types acceptés par SON propriétaire', async () => {
    // Par défaut : tout le monde reçoit tout.
    expect(await pushedTo({ type: 'order', title: 'Commande', body: 'b' })).toEqual([aliceEndpoint, bobEndpoint].sort());

    await putPrefs(aliceBrowser, { push: { orders: false, system: false } });
    await putPrefs(bobBrowser, { push: { payments: false } });

    expect(await pushedTo({ type: 'order', title: 'Commande', body: 'b' })).toEqual([bobEndpoint]);
    expect(await pushedTo({ type: 'payment', title: 'Paiement', body: 'b' })).toEqual([aliceEndpoint]);
    expect(await pushedTo({ type: 'security', severity: 'critical', title: 'Alerte', body: 'b' })).toEqual([aliceEndpoint, bobEndpoint].sort());
    expect(await pushedTo({ type: 'system', title: 'Système', body: 'b' })).toEqual([bobEndpoint]);

    // Notification ciblée : seulement ce compte, et seulement s'il accepte le type.
    expect(await pushedTo({ type: 'order', title: 'Pour alice', body: 'b', userId: alice.user.id })).toEqual([]);
    expect(await pushedTo({ type: 'payment', title: 'Pour alice', body: 'b', userId: alice.user.id })).toEqual([aliceEndpoint]);
    expect(await pushedTo({ type: 'order', title: 'Pour bob', body: 'b', userId: bob.user.id })).toEqual([bobEndpoint]);

    // Le centre de notifications, lui, montre tout : la commande non poussée à alice y figure, non lue.
    const list = await aliceBrowser.get<{ title: string }[]>('/api/notifications?type=order&unread=1&pageSize=100');
    expect(list.body.data.map((item) => item.title)).toContain('Commande');

    // L'envoi d'essai n'est pas filtré.
    fetchMock.mockClear();
    expect((await aliceBrowser.post<{ ok: boolean }>('/api/push/test')).body.data.ok).toBe(true);
  });
});
