/**
 * AUDIT DE SÉCURITÉ — re-confirmation TOTP (step-up) et vérifications faites depuis une session ouverte.
 * Chaque test « A-xx » énonce le comportement sûr attendu : il échoue tant que la faille existe.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/index.js';
import { advance, Browser, buildTestApp, createTestAdmin, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

let app: FastifyInstance;
let alice: TestAdmin;
let bob: TestAdmin;

beforeAll(async () => {
  useFakeClock();
  app = await buildTestApp();
  alice = await createTestAdmin('alice');
  bob = await createTestAdmin('bob');
});

afterAll(async () => {
  await app.close();
});

/** Session ouverte dont la fenêtre de step-up (accordée d'office à la connexion) est expirée. */
async function sessionWithoutStepUp(admin: TestAdmin): Promise<Browser> {
  const browser = new Browser(app, uniqueIp());
  await browser.login(admin);
  advance(6 * 60_000);
  expect((await browser.post('/api/test/critical')).errorCode).toBe('STEP_UP_REQUIRED');
  return browser;
}

describe('A-05 — redémarrage Pterodactyl / reboot Proxmox : interruption de service sans re-confirmation TOTP', () => {
  // Les intégrations ne sont pas configurées : une route qui exige le step-up répond 403 STEP_UP_REQUIRED AVANT
  // tout le reste ; une route qui ne l'exige pas va jusqu'à 409 INTEGRATION_NOT_CONFIGURED.
  it('référence : « stop » et « kill » exigent bien le step-up, « start » non', async () => {
    const browser = await sessionWithoutStepUp(alice);
    expect((await browser.post('/api/pterodactyl/servers/1/power', { signal: 'stop' })).errorCode).toBe('STEP_UP_REQUIRED');
    expect((await browser.post('/api/pterodactyl/servers/1/power', { signal: 'kill' })).errorCode).toBe('STEP_UP_REQUIRED');
    expect((await browser.post('/api/pterodactyl/servers/1/power', { signal: 'start' })).errorCode).toBe('INTEGRATION_NOT_CONFIGURED');
    expect((await browser.post('/api/proxmox/guests/pve1/qemu/100/action', { action: 'shutdown' })).errorCode).toBe('STEP_UP_REQUIRED');
    expect((await browser.post('/api/proxmox/guests/pve1/qemu/100/action', { action: 'stop' })).errorCode).toBe('STEP_UP_REQUIRED');
    expect((await browser.post('/api/proxmox/guests/pve1/qemu/100/action', { action: 'start' })).errorCode).toBe('INTEGRATION_NOT_CONFIGURED');
  });

  it('Pterodactyl « restart » (arrêt puis démarrage) exige le step-up comme « stop »', async () => {
    const browser = await sessionWithoutStepUp(alice);
    const res = await browser.post('/api/pterodactyl/servers/1/power', { signal: 'restart' });
    expect(res.errorCode).toBe('STEP_UP_REQUIRED');
  });

  it('Proxmox « reboot » (arrêt puis démarrage) exige le step-up comme « shutdown »', async () => {
    const browser = await sessionWithoutStepUp(alice);
    const res = await browser.post('/api/proxmox/guests/pve1/qemu/100/action', { action: 'reboot' });
    expect(res.errorCode).toBe('STEP_UP_REQUIRED');
  });
});

describe('A-06 — mot de passe actuel : des requêtes parallèles dépassent les 5 essais du verrouillage', () => {
  it('une fois le compte verrouillé par 5 échecs, une tentative encore en vol n’est plus acceptée', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.login(bob); // step-up accordé par la connexion
    const newPassword = 'Nouveau-Secret!Solide-42-Zx';
    const guess = (currentPassword: string) => browser.post('/api/security/password', { currentPassword, newPassword });

    // 12 mauvais mots de passe puis le bon, envoyés en même temps : tous franchissent le contrôle de
    // verrouillage avant que le premier échec ne soit compté.
    const responses = await Promise.all([...Array.from({ length: 12 }, (_unused, i) => guess(`Mauvais-Essai!-${i}-Abcdef`)), guess(bob.password)]);
    const statuses = responses.map((r) => r.status);
    const user = db.prepare('SELECT locked_until, lock_count FROM users WHERE id = ?').get(bob.user.id) as { locked_until: number | null; lock_count: number };

    // Pré-requis observés : le compte s'est bien verrouillé pendant la rafale.
    expect(user.lock_count).toBeGreaterThanOrEqual(1);
    // Comportement sûr : la 13e tentative, évaluée après le verrouillage, est refusée et le mot de passe est inchangé.
    expect(statuses[12], `statuts : ${statuses.join(',')}`).not.toBe(200);
    const changed = db.prepare('SELECT password_changed_at, created_at FROM users WHERE id = ?').get(bob.user.id) as { password_changed_at: number; created_at: number };
    expect(changed.password_changed_at).toBe(changed.created_at);
  });
});

describe('vérifié — step-up : points contrôlés', () => {
  it('toutes les routes critiques déclarées refusent une session sans step-up, quelle que soit la méthode ou la casse', async () => {
    const browser = await sessionWithoutStepUp(alice);
    const critical: [('POST' | 'PUT' | 'DELETE'), string, Record<string, unknown>][] = [
      ['PUT', '/api/settings/whmcs', { url: 'https://whmcs.exemple.test' }],
      ['PUT', '/api/settings/pterodactyl', { url: 'https://ptero.exemple.test' }],
      ['PUT', '/api/settings/proxmox', { url: 'https://pve.exemple.test:8006' }],
      ['PUT', '/api/settings/notifications', { discordEnabled: true }],
      ['PUT', '/api/security/ip-allowlist', { entries: [] }],
      ['POST', '/api/security/password', { currentPassword: 'x', newPassword: 'y' }],
      ['POST', '/api/security/totp/regenerate', {}],
      ['POST', '/api/security/backup-codes/regenerate', {}],
      ['POST', '/api/mail/accounts', {}],
      ['PUT', '/api/mail/accounts/1', {}],
      ['DELETE', '/api/mail/accounts/1', {}],
      ['POST', '/api/pterodactyl/servers/1/suspend', {}],
    ];
    for (const [method, url, body] of critical) {
      const res = await browser.request(method, url, method === 'DELETE' ? {} : { body });
      expect(res.errorCode, `${method} ${url}`).toBe('STEP_UP_REQUIRED');
    }
    // Variantes de méthode / de chemin : jamais d'exécution (401, 403 ou 404).
    for (const [method, url] of [
      ['POST', '/api/settings/whmcs'],
      ['PATCH', '/api/settings/whmcs'],
      ['PUT', '/api/Settings/whmcs'],
      ['PUT', '/api/settings/whmcs/'],
      ['PUT', '/api/settings/%77hmcs'],
    ] as const) {
      const res = await browser.request(method, url, { body: { url: 'https://whmcs.exemple.test' } });
      expect([401, 403, 404], `${method} ${url}`).toContain(res.status);
      expect(res.status === 403 ? res.errorCode : 'ok', `${method} ${url}`).not.toBe('CSRF_INVALID');
    }
    const view = await browser.get<{ configured: boolean }>('/api/settings/whmcs');
    expect(view.body.data.configured).toBe(false);
  });

  it('sans secret en attente connu, /api/security/totp/confirm ne permet pas de remplacer le 2FA sans step-up', async () => {
    const browser = await sessionWithoutStepUp(alice);
    const res = await browser.post('/api/security/totp/confirm', { code: '123456' });
    expect(res.status).toBe(400);
    expect((await browser.post('/api/security/totp/regenerate')).errorCode).toBe('STEP_UP_REQUIRED');
  });
});
