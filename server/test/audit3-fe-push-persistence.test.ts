import { spawn } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { KnownDevice, PushSubscriptionInfo, SessionInfo, TotpSetup } from '@shared/api-types';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { generateSync } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Audit 3 (frontend / déploiement) — E-01, test de NON-RÉGRESSION.
 * Un abonnement push est lié à l'appareil qui l'a créé et disparaît avec lui : déconnexion, révocation de la
 * session, « fermer les autres sessions », changement de mot de passe, nouveau secret 2FA, nouveaux codes de
 * secours, oubli de l'appareil et commandes de secours de la CLI. L'abonnement exige un step-up, le compte peut
 * lister et retirer ses abonnements, et rien n'est envoyé vers un appareil qui n'est plus connu du compte.
 */
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../src/core/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/http.js')>()),
  upstreamFetch: fetchMock,
}));

import { flushAlerts, resetAlertThrottle } from '../src/core/alerts.js';
import { db } from '../src/db/index.js';
import { flushNotifications, notify } from '../src/modules/notifications/service.js';
import { advance, Browser, buildTestApp, createTestAdmin, totpCode, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

let app: FastifyInstance;
let alice: TestAdmin;
let bob: TestAdmin;
let endpointCounter = 0;

function pushKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

const exists = (endpoint: string): boolean => db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ?').get(endpoint) !== undefined;

/** Nouveau navigateur (nouvel appareil) connecté au compte. */
async function device(admin: TestAdmin): Promise<Browser> {
  advance(61_000);
  const browser = new Browser(app, uniqueIp());
  await browser.login(admin);
  return browser;
}

/** Abonne le navigateur aux push (après step-up) et retourne son point de terminaison. */
async function subscribe(browser: Browser, admin: TestAdmin): Promise<string> {
  const endpoint = `https://fcm.googleapis.com/fcm/send/appareil-${(endpointCounter += 1)}`;
  expect((await browser.stepUp(admin)).status).toBe(200);
  const res = await browser.post('/api/push/subscribe', { endpoint, expirationTime: null, keys: pushKeys() });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(exists(endpoint)).toBe(true);
  return endpoint;
}

/** Un appareil légitime et un appareil « intrus », tous deux abonnés aux push du même compte. */
async function twoDevices(admin: TestAdmin) {
  const legit = await device(admin);
  const legitEndpoint = await subscribe(legit, admin);
  const intruder = await device(admin);
  const intruderEndpoint = await subscribe(intruder, admin);
  return { legit, legitEndpoint, intruder, intruderEndpoint };
}

beforeAll(async () => {
  useFakeClock();
  app = await buildTestApp();
  alice = await createTestAdmin('alice');
  bob = await createTestAdmin('bob');
});

beforeEach(async () => {
  await flushAlerts();
  await flushNotifications();
  resetAlertThrottle();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({ ok: true, status: 201, body: null }));
});

afterAll(async () => {
  await app.close();
});

describe('audit3-fe : un abonnement push ne survit pas à l’appareil qui l’a créé', () => {
  it('scénario d’origine : l’intrus chassé ne reçoit plus l’alerte « mot de passe modifié »', async () => {
    const { legit, legitEndpoint, intruder, intruderEndpoint } = await twoDevices(alice);

    // L'intrus se déconnecte lui-même : son abonnement disparaît avec sa session.
    expect((await intruder.post('/api/auth/logout')).status).toBe(200);
    expect(exists(intruderEndpoint)).toBe(false);

    advance(31_000);
    expect((await legit.post('/api/security/sessions/revoke-others')).status).toBe(200);
    expect((await legit.stepUp(alice)).status).toBe(200);
    const newPassword = 'Nouveau-Mot2Passe!Tres-Long';
    const changed = await legit.post('/api/security/password', { currentPassword: alice.password, newPassword });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    alice.password = newPassword;

    await flushAlerts();
    await flushNotifications();
    const pushed = fetchMock.mock.calls.map((call) => call[1] as string);
    expect(pushed).not.toContain(intruderEndpoint);
    // L'appareil légitime, lui, est toujours prévenu.
    expect(pushed).toContain(legitEndpoint);

    // Les abonnements sont visibles depuis le panel.
    expect((await legit.get('/api/push/subscriptions')).status).toBe(200);
  });

  it('subscribe exige un step-up et un appareil identifié', async () => {
    const browser = await device(bob);
    // La fenêtre de step-up ouverte par la connexion est écoulée.
    advance(6 * 60_000);
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE revoked_at IS NULL').run(Date.now());
    const endpoint = 'https://fcm.googleapis.com/fcm/send/sans-step-up';
    const refused = await browser.post('/api/push/subscribe', { endpoint, keys: pushKeys() });
    expect(refused.errorCode).toBe('STEP_UP_REQUIRED');
    expect(exists(endpoint)).toBe(false);

    // Sans cookie d'appareil (ou avec celui d'un autre appareil) : refus.
    expect((await browser.stepUp(bob)).status).toBe(200);
    const deviceCookie = browser.cookies.get('tc_device')!;
    browser.cookies.delete('tc_device');
    expect((await browser.post('/api/push/subscribe', { endpoint, keys: pushKeys() })).status).toBe(400);
    browser.cookies.set('tc_device', randomBytes(32).toString('base64url'));
    expect((await browser.post('/api/push/subscribe', { endpoint, keys: pushKeys() })).status).toBe(400);
    expect(exists(endpoint)).toBe(false);
    browser.cookies.set('tc_device', deviceCookie);

    // Avec step-up et le bon appareil : accepté, rattaché à l'appareil et à la session.
    expect((await browser.post('/api/push/subscribe', { endpoint, keys: pushKeys() })).status).toBe(200);
    const row = db.prepare('SELECT p.user_id, p.device_id, p.session_id, s.device_id AS session_device FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id WHERE p.endpoint = ?').get(endpoint) as {
      user_id: number;
      device_id: string;
      session_device: string;
    };
    expect(row.user_id).toBe(bob.user.id);
    expect(row.device_id).toBe(row.session_device);
    expect(db.prepare('SELECT 1 FROM known_devices WHERE user_id = ? AND device_hash = ?').get(bob.user.id, row.device_id)).toBeDefined();

    // Le même navigateur réabonné par l'autre compte : l'abonnement change de propriétaire, sans doublon.
    const other = await device(alice);
    expect((await other.stepUp(alice)).status).toBe(200);
    expect((await other.post('/api/push/subscribe', { endpoint, keys: pushKeys() })).status).toBe(200);
    expect(db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').all(endpoint)).toEqual([{ user_id: alice.user.id }]);
  });

  it('déconnexion : retire l’abonnement de l’appareil déconnecté seulement', async () => {
    const { legit, legitEndpoint, intruderEndpoint } = await twoDevices(bob);
    expect((await legit.post('/api/auth/logout')).status).toBe(200);
    expect(exists(legitEndpoint)).toBe(false);
    expect(exists(intruderEndpoint)).toBe(true);
  });

  it('révocation d’une session : retire l’abonnement de l’appareil de cette session', async () => {
    const { legit, legitEndpoint, intruder, intruderEndpoint } = await twoDevices(bob);
    const sessions = await legit.get<SessionInfo[]>('/api/security/sessions');
    const target = sessions.body.data.find((session) => session.ip === intruder.ip)!;
    expect((await legit.delete(`/api/security/sessions/${target.id}`)).status).toBe(200);
    expect(exists(intruderEndpoint)).toBe(false);
    expect(exists(legitEndpoint)).toBe(true);
  });

  it('« fermer les autres sessions » : seul l’appareil courant garde son abonnement', async () => {
    const { legit, legitEndpoint, intruderEndpoint } = await twoDevices(bob);
    expect((await legit.post('/api/security/sessions/revoke-others')).status).toBe(200);
    expect(exists(intruderEndpoint)).toBe(false);
    expect(exists(legitEndpoint)).toBe(true);
  });

  it('changement de mot de passe : seul l’appareil courant garde son abonnement', async () => {
    const { legit, legitEndpoint, intruderEndpoint } = await twoDevices(bob);
    expect((await legit.stepUp(bob)).status).toBe(200);
    const newPassword = 'Autre-Mot2Passe!Solide-Xyz9';
    expect((await legit.post('/api/security/password', { currentPassword: bob.password, newPassword })).status).toBe(200);
    bob.password = newPassword;
    expect(exists(intruderEndpoint)).toBe(false);
    expect(exists(legitEndpoint)).toBe(true);
  });

  it('confirmation d’un nouveau secret 2FA : seul l’appareil courant garde son abonnement', async () => {
    const { legit, legitEndpoint, intruderEndpoint } = await twoDevices(bob);
    expect((await legit.stepUp(bob)).status).toBe(200);
    const setup = await legit.post<TotpSetup>('/api/security/totp/regenerate');
    expect(setup.status).toBe(200);
    // Le pas courant a pu servir au step-up : on passe au suivant.
    advance(30_000);
    const confirmed = await legit.post('/api/security/totp/confirm', { code: totpCode(setup.body.data.secret) });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    bob.totpSecret = setup.body.data.secret;
    expect(exists(intruderEndpoint)).toBe(false);
    expect(exists(legitEndpoint)).toBe(true);
  });

  it('régénération des codes de secours : seul l’appareil courant garde son abonnement', async () => {
    const { legit, legitEndpoint, intruderEndpoint } = await twoDevices(bob);
    expect((await legit.stepUp(bob)).status).toBe(200);
    expect((await legit.post('/api/security/backup-codes/regenerate')).status).toBe(200);
    expect(exists(intruderEndpoint)).toBe(false);
    expect(exists(legitEndpoint)).toBe(true);
  });

  it('oubli d’un appareil : retire son abonnement', async () => {
    const { legit, legitEndpoint, intruder, intruderEndpoint } = await twoDevices(bob);
    const devices = await intruder.get<KnownDevice[]>('/api/security/devices');
    const intruderDevice = devices.body.data.find((item) => item.current)!;
    expect((await legit.delete(`/api/security/devices/${intruderDevice.id}`)).status).toBe(200);
    expect(exists(intruderEndpoint)).toBe(false);
    expect(exists(legitEndpoint)).toBe(true);
  });

  it('aucun envoi vers un appareil qui n’est plus connu du compte', async () => {
    const { legitEndpoint, intruderEndpoint } = await twoDevices(alice);
    // L'appareil disparaît des appareils connus par un autre chemin que la route d'oubli.
    const { device_id: deviceId } = db.prepare('SELECT device_id FROM push_subscriptions WHERE endpoint = ?').get(intruderEndpoint) as { device_id: string };
    db.prepare('DELETE FROM known_devices WHERE user_id = ? AND device_hash = ?').run(alice.user.id, deviceId);

    await notify({ type: 'security', severity: 'critical', title: 'Alerte', body: 'b', channels: { push: true } });
    await flushNotifications();
    const pushed = fetchMock.mock.calls.map((call) => call[1] as string);
    expect(pushed).not.toContain(intruderEndpoint);
    expect(pushed).toContain(legitEndpoint);
    expect(exists(intruderEndpoint)).toBe(false);
  });

  it('liste et retrait : chaque compte ne voit et ne retire que ses abonnements (step-up, journalisé)', async () => {
    db.prepare('DELETE FROM push_subscriptions').run();
    const a1 = await device(alice);
    const aliceEndpoint = await subscribe(a1, alice);
    const a2 = await device(alice);
    const aliceOther = await subscribe(a2, alice);
    const b1 = await device(bob);
    const bobEndpoint = await subscribe(b1, bob);

    const aliceList = await a1.get<PushSubscriptionInfo[]>('/api/push/subscriptions');
    expect(aliceList.status).toBe(200);
    expect(aliceList.body.data).toHaveLength(2);
    expect(aliceList.body.data.filter((item) => item.current)).toHaveLength(1);
    expect(Object.keys(aliceList.body.data[0]!).sort()).toEqual(['createdAt', 'current', 'deviceLabel', 'id']);
    // Ni point de terminaison ni clé dans la réponse.
    expect(JSON.stringify(aliceList.body)).not.toContain('fcm.googleapis.com');

    const bobList = await b1.get<PushSubscriptionInfo[]>('/api/push/subscriptions');
    expect(bobList.body.data).toHaveLength(1);
    const bobId = bobList.body.data[0]!.id;

    // Alice ne peut pas retirer l'abonnement de bob.
    expect((await a1.stepUp(alice)).status).toBe(200);
    expect((await a1.delete(`/api/push/subscriptions/${bobId}`)).status).toBe(404);
    expect(exists(bobEndpoint)).toBe(true);

    // Retrait de son autre appareil.
    const otherId = aliceList.body.data.find((item) => !item.current)!.id;
    expect((await a1.delete(`/api/push/subscriptions/${otherId}`)).status).toBe(200);
    expect(exists(aliceOther)).toBe(false);
    expect(exists(aliceEndpoint)).toBe(true);
    expect((await a1.delete(`/api/push/subscriptions/${otherId}`)).status).toBe(404);
    expect((await a1.delete('/api/push/subscriptions/abc')).status).toBe(400);

    // Sans step-up : refus.
    advance(6 * 60_000);
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE revoked_at IS NULL').run(Date.now());
    const currentId = aliceList.body.data.find((item) => item.current)!.id;
    expect((await a1.delete(`/api/push/subscriptions/${currentId}`)).errorCode).toBe('STEP_UP_REQUIRED');
    expect(exists(aliceEndpoint)).toBe(true);

    const logged = db.prepare("SELECT success FROM audit_log WHERE action = 'notifications.push.remove' AND user_id = ? ORDER BY id").all(alice.user.id) as { success: number }[];
    expect(logged.map((row) => row.success)).toEqual([0, 1, 0]);
  });
});

describe('audit3-fe : commandes de secours de la CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'talcloud-push-cli-'));
  const dbPath = join(dir, 'cli.db');
  const serverDir = resolve(import.meta.dirname, '..');
  const tsx = join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  function runCli(args: string[], answers: (string | ((output: string) => string | null))[] = []): Promise<{ code: number | null; output: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [tsx, 'src/cli/index.ts', ...args], { cwd: serverDir, env: { ...process.env, NODE_ENV: 'test', DB_PATH: dbPath }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      const queue = [...answers];
      let answeredAt = -1;
      const feed = () => {
        if (!queue.length || !output.endsWith(': ') || output.length === answeredAt) return;
        const next = queue[0]!;
        const value = typeof next === 'function' ? next(output) : next;
        if (value === null) return;
        queue.shift();
        answeredAt = output.length;
        child.stdin.write(`${value}\n`);
        if (!queue.length) child.stdin.end();
      };
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        feed();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      if (!answers.length) child.stdin.end();
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`CLI trop lente. Sortie :\n${output}`));
      }, 60_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ code, output });
      });
    });
  }

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reset-password, reset-2fa et revoke-sessions retirent tous les abonnements push du compte', async () => {
    // Première exécution : crée la base et applique les migrations (le compte n'existe pas encore).
    expect((await runCli(['revoke-sessions', 'bob'])).code).not.toBe(0);

    // Compte copié depuis la base de test (mêmes clés de chiffrement), avec un appareil connu.
    const source = db.prepare('SELECT * FROM users WHERE id = ?').get(bob.user.id) as Record<string, unknown>;
    const file = new Database(dbPath);
    const columns = Object.keys(source);
    file.prepare(`INSERT INTO users (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map((column) => source[column] as never));
    const userId = source.id as number;
    file.prepare("INSERT INTO known_devices (user_id, device_hash, label, first_seen_at, last_seen_at) VALUES (?, 'appareil', 'Chrome', 1, 1)").run(userId);
    const insertSub = file.prepare("INSERT INTO push_subscriptions (user_id, endpoint, keys_enc, created_at, device_id) VALUES (?, ?, 'v1:x:y:z', 1, 'appareil')");
    const count = () => (file.prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?').get(userId) as { c: number }).c;

    try {
      insertSub.run(userId, 'https://fcm.googleapis.com/fcm/send/cli-1');
      insertSub.run(userId, 'https://fcm.googleapis.com/fcm/send/cli-2');
      const revoke = await runCli(['revoke-sessions', 'bob']);
      expect(revoke.code, revoke.output).toBe(0);
      expect(count()).toBe(0);

      insertSub.run(userId, 'https://fcm.googleapis.com/fcm/send/cli-3');
      const password = 'Cli-Nouveau!Mot2Passe-Long';
      const reset = await runCli(['reset-password', 'bob'], [password, password]);
      expect(reset.code, reset.output).toBe(0);
      expect(count()).toBe(0);

      insertSub.run(userId, 'https://fcm.googleapis.com/fcm/send/cli-4');
      const totpFromOutput = (output: string): string | null => {
        const secret = /Secret : ([A-Z2-7]+)/.exec(output)?.[1];
        // Horloge réelle : celle du test est simulée, pas celle de la CLI.
        return secret ? generateSync({ secret, epoch: Math.floor((performance.timeOrigin + performance.now()) / 1000) }) : null;
      };
      const reset2fa = await runCli(['reset-2fa', 'bob'], [totpFromOutput]);
      expect(reset2fa.code, reset2fa.output).toBe(0);
      expect(count()).toBe(0);
    } finally {
      file.close();
    }
  });
});

