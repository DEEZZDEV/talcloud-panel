/**
 * AUDIT DE SÉCURITÉ — authentification, limitation de débit, verrouillage.
 *
 * Chaque test énonce le comportement SÛR attendu : un test « A-xx » échoue tant que la faille existe et servira
 * de test de non-régression une fois corrigée. Les tests « vérifié » décrivent des points contrôlés et trouvés solides.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAlertThrottle } from '../src/core/alerts.js';
import { outbox } from '../src/core/mailer.js';
import { db } from '../src/db/index.js';
import { advance, Browser, buildTestApp, createTestAdmin, freshTotp, mailedCode, totpCode, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

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
  // Chaque test repart de compteurs neufs (fenêtres de débit, verrouillages, blocages d'IP).
  advance(2 * 3600_000);
  db.exec('DELETE FROM auth_failures; DELETE FROM auth_ip_blocks; DELETE FROM login_challenges;');
  db.exec('UPDATE users SET failed_attempts = 0, lock_count = 0, locked_until = NULL');
  outbox.length = 0;
  resetAlertThrottle();
});

const wrongLogin = (browser: Browser, url = '/api/auth/login', identifier = 'inconnu') =>
  browser.post(url, { identifier, password: 'Mauvais-Mot-De-Passe-123!' });

describe('A-03 — chemin encodé en pourcentage : la limite de débit et le blocage d’IP de /api/auth sont contournés', () => {
  it('le routeur décode bien « /api/%61uth/login » vers la route de connexion (pré-requis du constat)', async () => {
    const res = await wrongLogin(new Browser(app, uniqueIp()), '/api/%61uth/login');
    // 401 INVALID_CREDENTIALS = le gestionnaire de connexion a bien été exécuté (une route inconnue répondrait UNAUTHENTICATED).
    expect(res.status).toBe(401);
    expect(res.errorCode).toBe('INVALID_CREDENTIALS');
  });

  it('la limite de 10 requêtes/minute s’applique aussi au chemin encodé', async () => {
    const browser = new Browser(app, uniqueIp());
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      // Route sans effet de bord (pas de challenge → 401) pour n’observer que la limite de débit.
      statuses.push((await browser.post('/api/%61uth/login/verify', { emailCode: '000000', totpCode: '000000' })).status);
    }
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('une IP bloquée après trop d’échecs ne peut pas continuer à deviner des mots de passe via le chemin encodé', async () => {
    const browser = new Browser(app, uniqueIp());
    for (let i = 0; i < 11; i += 1) {
      await wrongLogin(browser);
      advance(7_000); // reste sous la limite de 10 requêtes/minute : seul le blocage d'IP est en jeu
    }
    // Contrôle : le chemin normal est bien bloqué.
    expect((await wrongLogin(browser)).status).toBe(429);
    advance(61_000);
    const bypass = await wrongLogin(browser, '/api/%61uth/login');
    expect(bypass.status).toBe(429);
  });
});

describe('vérifié — la limitation de débit regroupe bien les adresses IPv6 par préfixe /64', () => {
  it('11 requêtes d’authentification depuis 11 adresses du même /64 : la 11e est refusée', async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 11; i += 1) {
      const browser = new Browser(app, `2001:db8:a2:1::${i.toString(16)}`);
      statuses.push((await browser.post('/api/auth/login/verify', { emailCode: '000000', totpCode: '000000' })).status);
    }
    expect(statuses[10]).toBe(429);
  });
});

describe('A-02 — verrouillage d’un compte à distance par un anonyme', () => {
  it('5 mauvais mots de passe envoyés par un tiers ne privent pas l’administrateur connecté de ses actions critiques (step-up)', async () => {
    const admin = new Browser(app, uniqueIp());
    await admin.login(alice);
    advance(6 * 60_000); // la fenêtre de step-up ouverte par la connexion est passée

    const attacker = new Browser(app, uniqueIp());
    for (let i = 0; i < 5; i += 1) await wrongLogin(attacker, '/api/auth/login', alice.username);

    await admin.get('/api/auth/session');
    const stepUp = await admin.stepUp(alice);
    expect(stepUp.status).toBe(200);
  });

  it('5 mauvais mots de passe envoyés par un tiers n’empêchent pas le titulaire de se connecter depuis son appareil connu', async () => {
    const admin = new Browser(app, uniqueIp());
    await admin.login(bob);
    await admin.post('/api/auth/logout');

    const attacker = new Browser(app, uniqueIp());
    for (let i = 0; i < 5; i += 1) await wrongLogin(attacker, '/api/auth/login', bob.username);

    const first = await admin.post('/api/auth/login', { identifier: bob.username, password: bob.password });
    expect(first.status).toBe(200);
  });

});

describe('A-04 — le verrouillage du compte ne freine pas la devinette du mot de passe', () => {
  it('pendant un verrouillage, la réponse ne confirme pas qu’un mot de passe est le bon (pas d’oracle 423 / 401)', async () => {
    const attacker = new Browser(app, uniqueIp());
    for (let i = 0; i < 5; i += 1) await wrongLogin(attacker, '/api/auth/login', alice.username);
    const other = new Browser(app, uniqueIp());
    const wrong = await wrongLogin(other, '/api/auth/login', alice.username);
    const right = await other.post('/api/auth/login', { identifier: alice.username, password: alice.password });
    expect({ status: right.status, code: right.errorCode }).toEqual({ status: wrong.status, code: wrong.errorCode });
  });
});

describe('vérifié — contournements d’authentification testés sans succès', () => {
  it('méthodes, casse, slash final, double slash, préfixes : aucune route protégée n’est atteinte sans session', async () => {
    const anonymous = new Browser(app, uniqueIp());
    const attempts: [Parameters<Browser['request']>[0], string][] = [
      ['HEAD', '/api/test/protected'],
      ['OPTIONS', '/api/test/protected'],
      ['GET', '/API/test/protected'],
      ['GET', '/api/test/protected/'],
      ['GET', '//api/test/protected'],
      ['GET', '/api//test/protected'],
      ['GET', '/api/test/%70rotected'],
      ['GET', '/api/test/protected;x=1'],
      ['GET', '/./api/test/protected'],
      ['GET', '/x/../api/test/protected'],
      ['GET', '/api/security/audit'],
      ['GET', '/api/events'],
      ['GET', '/api/settings/whmcs'],
      ['GET', '/api/settings/security'],
      ['GET', '/api/settings/notifications.vapid'],
      ['GET', '/api/mail/accounts'],
    ];
    for (const [method, url] of attempts) {
      const res = await anonymous.request(method, url);
      expect([401, 404, 400], `${method} ${url}`).toContain(res.status);
      expect(JSON.stringify(res.body), `${method} ${url}`).not.toContain('"user"');
      if (res.status === 404) expect(url.startsWith('/api')).toBe(false);
    }
  });

  it('X-Forwarded-For / X-Forwarded-Host / X-Forwarded-Proto sont ignorés quand TRUST_PROXY=false', async () => {
    const ip = uniqueIp();
    const browser = new Browser(app, ip);
    await browser.login(alice);
    const res = await browser.get<{ client: { ip: string } }>('/api/test/protected', { 'x-forwarded-for': '10.9.9.9', 'x-real-ip': '10.9.9.9', forwarded: 'for=10.9.9.9' });
    expect(res.body.data.client.ip).toBe(ip);
  });

  it('un code TOTP accepté à la connexion ne peut pas être rejoué pour un step-up, ni un code de step-up pour un second step-up', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.post('/api/auth/login', { identifier: alice.username, password: alice.password });
    const code = freshTotp(alice.totpSecret);
    let step = await browser.post<{ step: string; session?: { csrfToken: string } }>('/api/auth/login/verify', { emailCode: mailedCode(alice.email, 'Code de connexion'), totpCode: code });
    if (step.body.data.step === 'device_confirmation') {
      step = await browser.post('/api/auth/login/confirm-device', { code: mailedCode(alice.email, 'Confirmation de connexion') });
    }
    browser.csrfToken = step.body.data.session!.csrfToken;
    expect((await browser.post('/api/auth/step-up', { totpCode: code })).status).toBe(401);
    // Code du pas précédent (toujours dans la fenêtre de tolérance) : refusé lui aussi.
    expect((await browser.post('/api/auth/step-up', { totpCode: totpCode(alice.totpSecret, -1) })).status).toBe(401);
    const next = freshTotp(alice.totpSecret);
    expect((await browser.post('/api/auth/step-up', { totpCode: next })).status).toBe(200);
    expect((await browser.post('/api/auth/step-up', { totpCode: next })).status).toBe(401);
  });

  it('le code mail seul, le TOTP seul, ou un saut direct à la confirmation d’appareil n’ouvrent jamais de session', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.post('/api/auth/login', { identifier: bob.username, password: bob.password });
    const emailCode = mailedCode(bob.email, 'Code de connexion');
    expect((await browser.post('/api/auth/login/confirm-device', { code: '12345678' })).status).toBe(400);
    expect((await browser.post('/api/auth/login/verify', { emailCode, totpCode: '000000' })).status).toBe(401);
    expect((await browser.post('/api/auth/login/verify', { emailCode: '000000', totpCode: freshTotp(bob.totpSecret) })).status).toBe(401);
    expect((await browser.post('/api/auth/login/verify', { emailCode })).status).toBe(400);
    const session = await browser.get<{ authenticated: boolean }>('/api/auth/session');
    expect(session.body.data.authenticated).toBe(false);
    expect((await browser.get('/api/test/protected')).status).toBe(401);
  });

  it('le cookie de challenge n’est pas accepté comme cookie de session (et inversement)', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.post('/api/auth/login', { identifier: bob.username, password: bob.password });
    const challenge = browser.cookies.get('tc_login')!;
    expect(challenge).toBeTruthy();
    const forged = new Browser(app, uniqueIp());
    forged.cookies.set('tc_session', challenge);
    expect((await forged.get('/api/test/protected')).status).toBe(401);
  });

  it('un administrateur ne peut ni révoquer la session, ni oublier l’appareil, ni lire le journal de l’autre', async () => {
    const a = new Browser(app, uniqueIp());
    const b = new Browser(app, uniqueIp());
    await a.login(alice);
    await b.login(bob);
    const bobSessions = await b.get<{ id: string }[]>('/api/security/sessions');
    const bobDevices = await b.get<{ id: number }[]>('/api/security/devices');
    expect((await a.delete(`/api/security/sessions/${bobSessions.body.data[0]!.id}`)).status).toBe(404);
    expect((await a.delete(`/api/security/devices/${bobDevices.body.data[0]!.id}`)).status).toBe(404);
    expect((await b.get('/api/test/protected')).status).toBe(200);
    const journal = await a.get<{ target: string | null }[]>('/api/security/audit?pageSize=100');
    expect(journal.body.data.some((entry) => entry.target?.includes('bob'))).toBe(false);
  });
});
