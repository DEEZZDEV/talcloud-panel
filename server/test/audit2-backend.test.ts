/**
 * AUDIT DE SÉCURITÉ — seconde passe : contre-vérification des corrections A-01 … A-06.
 * Les tests « B-xx » énoncent le comportement sûr attendu et échouent tant que le défaut existe.
 * Les tests « vérifié » décrivent les contournements essayés sans succès.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { flushAlerts, resetAlertThrottle } from '../src/core/alerts.js';
import { outbox } from '../src/core/mailer.js';
import { db } from '../src/db/index.js';
import { advance, Browser, buildTestApp, createTestAdmin, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

const APP_KEY = 'ptla_Audit2ApplicationKey0123456789abcdefABCDE';
const CLIENT_KEY = 'ptlc_Audit2ClientKey0123456789abcdefABCDEF0123';
const PVE_SECRET = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

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

beforeEach(() => {
  advance(26 * 3600_000);
  db.exec('DELETE FROM auth_failures; DELETE FROM auth_ip_blocks; DELETE FROM login_challenges;');
  db.exec('UPDATE users SET failed_attempts = 0, lock_count = 0, locked_until = NULL, unknown_failed_attempts = 0, unknown_lock_count = 0, unknown_locked_until = NULL, unknown_last_failure_at = NULL');
  outbox.length = 0;
  resetAlertThrottle();
});

const wrongLogin = (browser: Browser, identifier: string) => browser.post('/api/auth/login', { identifier, password: 'Mauvais-Mot-De-Passe-123!' });

describe('B-01 — file d’attente de connexion par identifiant : non bornée, un anonyme retarde le titulaire', () => {
  it('au-delà de quelques tentatives en attente sur le même identifiant, les suivantes sont refusées tout de suite (429/503)', async () => {
    // 40 adresses distinctes : ni la limite de débit par IP ni le blocage d'IP ne jouent.
    const flood = Array.from({ length: 40 }, () => wrongLogin(new Browser(app, uniqueIp()), alice.username));
    const statuses = (await Promise.all(flood)).map((r) => r.status);
    const refusedEarly = statuses.filter((s) => s === 429 || s === 503).length;
    expect(refusedEarly, `statuts : ${statuses.join(',')}`).toBeGreaterThan(0);
  });
});

describe('B-02 — connectionTimeout (60 s) plus court que les traitements les plus longs', () => {
  it('le délai d’inactivité de la connexion dépasse les traitements longs (envoi SMTP 90 s, pièce jointe 120 s) ou est désactivé', () => {
    // Node coupe la connexion après `connectionTimeout` sans octet échangé, même si le gestionnaire travaille encore :
    // le mail part quand même, mais le navigateur reçoit une erreur réseau (et l'utilisateur renvoie le message).
    const timeout = app.initialConfig.connectionTimeout ?? 0;
    expect(timeout === 0 || timeout > 120_000, `connectionTimeout = ${timeout} ms`).toBe(true);
  });
});

describe('B-03 — clés inconnues du corps de PUT /api/settings recopiées dans l’alerte et le journal', () => {
  it('une clé qui n’appartient pas au schéma est refusée, ou au moins absente de l’alerte envoyée aux administrateurs', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.login(alice);
    outbox.length = 0;
    const junk = `Urgent : votre compte est compromis, appelez le 0000 ${'x'.repeat(2000)}`;
    const res = await browser.put('/api/settings/pterodactyl', { url: 'https://ptero.exemple.test', applicationKey: APP_KEY, clientKey: CLIENT_KEY, [junk]: 1 });
    await flushAlerts();
    const alert = outbox.find((mail) => mail.subject.includes('Réglages'));
    if (res.status === 200) {
      expect(alert?.text ?? '').not.toContain('votre compte est compromis');
      const row = db.prepare("SELECT details FROM audit_log WHERE action = 'settings.pterodactyl.update' ORDER BY id DESC LIMIT 1").get() as { details: string };
      expect(row.details.length).toBeLessThan(1000);
    } else {
      expect(res.status).toBe(400);
    }
  });
});

describe('vérifié — A-01 : contournements de la ressaisie des secrets essayés sans succès', () => {
  interface View {
    secrets: Record<string, boolean>;
    values: Record<string, unknown>;
  }
  let browser: Browser;

  beforeEach(async () => {
    browser = new Browser(app, uniqueIp());
    await browser.login(bob);
    const base = await browser.put<View>('/api/settings/pterodactyl', { url: 'https://ptero.exemple.test', applicationKey: APP_KEY, clientKey: CLIENT_KEY });
    expect(base.status).toBe(200);
  });

  const stored = () => browser.get<View>('/api/settings/pterodactyl');

  it('URL seule, secret vide, un seul secret ressaisi, variantes d’écriture d’un AUTRE hôte : refusés', async () => {
    const attempts: Record<string, unknown>[] = [
      { url: 'https://attaquant.test' },
      { url: 'https://attaquant.test', applicationKey: '', clientKey: '' },
      { url: 'https://attaquant.test', applicationKey: 'ptla_ValeurQuelconque0123456789abcdef' },
      { url: 'https://ptero.exemple.test.attaquant.test' },
      { url: 'https://ptero.exemple.test:8443' },
      { url: 'http://ptero.exemple.test' },
      { url: 'https://ptero.exemple.test/sous-chemin' },
      { url: 'https://ptero.exemple.test@attaquant.test' },
      { url: 'https://ptero.exemple.test#@attaquant.test' },
      { url: 'https://ptero.exemple.test\\@attaquant.test' },
      { url: 'https://xn--ptero-exemple-test.attaquant.test' },
    ];
    for (const body of attempts) {
      const res = await browser.put('/api/settings/pterodactyl', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const view = await stored();
    expect(view.body.data.values.url).toBe('https://ptero.exemple.test');
    expect(view.body.data.secrets).toEqual({ applicationKey: true, clientKey: true });
  });

  it('la même destination écrite autrement (casse, slash final, port par défaut) n’exige pas de ressaisie et ne change rien', async () => {
    for (const url of ['HTTPS://PTERO.EXEMPLE.TEST', 'https://ptero.exemple.test/', 'https://ptero.exemple.test:443', ' https://ptero.exemple.test// ']) {
      const res = await browser.put<View>('/api/settings/pterodactyl', { url });
      expect(res.status, url).toBe(200);
      expect(res.body.data.values.url, url).toBe('https://ptero.exemple.test');
    }
  });

  it('en deux requêtes : effacer les secrets puis changer l’URL ne laisse aucun secret à envoyer', async () => {
    const cleared = await browser.put<View>('/api/settings/pterodactyl', { applicationKey: null, clientKey: null });
    expect(cleared.status).toBe(200);
    const moved = await browser.put<View>('/api/settings/pterodactyl', { url: 'https://attaquant.test' });
    expect(moved.status).toBe(200);
    expect(moved.body.data.secrets).toEqual({ applicationKey: false, clientKey: false });
    expect((await browser.get('/api/pterodactyl/servers')).errorCode).toBe('INTEGRATION_NOT_CONFIGURED');
  });

  it('Proxmox : verifyTls, caCert et url sont chacun des changements de destination ; le test de connexion exige le step-up', async () => {
    const base = await browser.put<View>('/api/settings/proxmox', { url: 'https://pve.exemple.test:8006', tokenId: 'audit@pve!panel', tokenSecret: PVE_SECRET });
    expect(base.status).toBe(200);
    for (const body of [{ verifyTls: false }, { url: 'https://pve.exemple.test:8007' }, { url: 'https://pve.exemple.test:8006/api2/json/../..//x' }, { caCert: 'pas un certificat' }]) {
      expect((await browser.put('/api/settings/proxmox', body)).status, JSON.stringify(body)).toBe(400);
    }
    // Même destination (suffixe /api2/json retiré par la normalisation) : acceptée.
    expect((await browser.put('/api/settings/proxmox', { url: 'https://pve.exemple.test:8006/api2/json' })).status).toBe(200);
    advance(6 * 60_000);
    for (const ns of ['proxmox', 'pterodactyl', 'whmcs', 'notifications']) {
      expect((await browser.post(`/api/settings/${ns}/test`)).errorCode, ns).toBe('STEP_UP_REQUIRED');
    }
  });

  it('toute modification de réglages prévient les deux administrateurs', async () => {
    outbox.length = 0;
    await browser.put('/api/settings/notifications', { notifyOrders: false });
    await flushAlerts();
    const alert = outbox.find((mail) => mail.subject.includes('notifications'));
    expect(alert).toBeTruthy();
    expect(alert!.to).toEqual(expect.arrayContaining([alice.email, bob.email]));
  });
});

describe('vérifié — A-02 / A-04 : verrou « appareils inconnus »', () => {
  it('pendant le verrou, bon et mauvais mot de passe depuis un appareil inconnu donnent la même réponse, sans cookie ni mail de code', async () => {
    for (let i = 0; i < 5; i += 1) await wrongLogin(new Browser(app, uniqueIp()), alice.username);
    outbox.length = 0;
    const a = new Browser(app, uniqueIp());
    const b = new Browser(app, uniqueIp());
    const wrong = await wrongLogin(a, alice.username);
    const right = await b.post('/api/auth/login', { identifier: alice.username, password: alice.password });
    expect({ s: right.status, body: right.body }).toEqual({ s: wrong.status, body: wrong.body });
    expect([...b.cookies.keys()]).toEqual([...a.cookies.keys()]);
    expect(Object.keys(right.raw.headers).sort()).toEqual(Object.keys(wrong.raw.headers).sort());
    expect(outbox.filter((mail) => mail.subject.includes('Code de connexion'))).toEqual([]);
  });

  it('un cookie d’appareil forgé, ou celui confirmé par l’AUTRE compte, ne vaut pas « appareil connu »', async () => {
    const bobBrowser = new Browser(app, uniqueIp());
    await bobBrowser.login(bob);
    const bobDevice = bobBrowser.cookies.get('tc_device')!;
    for (let i = 0; i < 5; i += 1) await wrongLogin(new Browser(app, uniqueIp()), alice.username);

    for (const cookie of [bobDevice, 'A'.repeat(43)]) {
      const attacker = new Browser(app, uniqueIp());
      attacker.cookies.set('tc_device', cookie);
      const res = await attacker.post('/api/auth/login', { identifier: alice.username, password: alice.password });
      expect(res.status).toBe(401);
    }
    // 5 mauvais mots de passe avec ces cookies ne posent pas non plus le verrou COMPLET du compte.
    for (let i = 0; i < 6; i += 1) {
      const attacker = new Browser(app, uniqueIp());
      attacker.cookies.set('tc_device', bobDevice);
      await wrongLogin(attacker, alice.username);
    }
    const row = db.prepare('SELECT locked_until, failed_attempts FROM users WHERE id = ?').get(alice.user.id) as { locked_until: number | null; failed_attempts: number };
    expect(row).toEqual({ locked_until: null, failed_attempts: 0 });
  });

  it('le verrou complet reste efficace contre la force brute du second facteur (5 essais, puis 423 et challenge détruit)', async () => {
    const attacker = new Browser(app, uniqueIp());
    expect((await attacker.post('/api/auth/login', { identifier: bob.username, password: bob.password })).status).toBe(200);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await attacker.post('/api/auth/login/verify', { emailCode: '000000', totpCode: '000000' })).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 423]);
    // Nouveau challenge impossible depuis cet appareil inconnu pendant le verrou, même avec le bon mot de passe.
    advance(61_000);
    expect((await attacker.post('/api/auth/login', { identifier: bob.username, password: bob.password })).status).toBe(401);
  });
});

describe('vérifié — A-03 : écarts URL brute / route', () => {
  it('les variantes encodées des routes d’authentification restent soumises à la limite de 10 requêtes/minute', async () => {
    const browser = new Browser(app, uniqueIp());
    const urls = ['/api/%61uth/login/verify', '/api/auth/%6cogin/verify', '/api/auth/login/%76erify', '/%61pi/auth/login/verify', '/api/%2561uth/login/verify', '/API/AUTH/login/verify', '/api//auth/login/verify'];
    const statuses: number[] = [];
    for (let i = 0; i < 14; i += 1) statuses.push((await browser.post(urls[i % urls.length]!, { emailCode: '000000', totpCode: '000000' })).status);
    expect(statuses.slice(10)).toEqual([429, 429, 429, 429]);
  });

  it('routes inconnues encodées sous /api : 401 sans session, jamais la page de l’application', async () => {
    const anonymous = new Browser(app, uniqueIp());
    for (const url of ['/%61pi/inconnu', '/%2561pi/inconnu', '/API/inconnu', '//api/inconnu', '/api%2Finconnu', '/%zz']) {
      const res = await anonymous.get(url);
      expect([400, 401], url).toContain(res.status);
    }
  });
});
