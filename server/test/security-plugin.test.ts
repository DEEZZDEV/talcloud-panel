import type { SessionState, StepUpResponse } from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/index.js';
import { ipMatchesEntries, ipRateKey, normalizeAllowlistEntry, setPanelAllowlist } from '../src/modules/auth/ip-allowlist.js';
import { advance, Browser, buildTestApp, createTestAdmin, freshTotp, ORIGIN, totpCode, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

let app: FastifyInstance;
let alice: TestAdmin;

const MIN = 60_000;

beforeAll(async () => {
  useFakeClock();
  app = await buildTestApp();
  alice = await createTestAdmin('alice');
});

afterAll(async () => {
  await app.close();
});

describe('en-têtes de sécurité', () => {
  it('CSP stricte, nosniff, no-referrer, Permissions-Policy, no-store sur /api', async () => {
    const res = await new Browser(app, uniqueIp()).get('/api/auth/session');
    const h = res.raw.headers;
    expect(h['content-security-policy']).toBe(
      "default-src 'self';script-src 'self';style-src 'self' 'unsafe-inline';img-src 'self' data: blob:;font-src 'self' data:;connect-src 'self';frame-src 'self' blob:;worker-src 'self';object-src 'none';base-uri 'self';form-action 'self';frame-ancestors 'none'",
    );
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['cache-control']).toBe('no-store');
    expect(String(h['permissions-policy'])).toContain('camera=()');
    expect(String(h['permissions-policy'])).toContain('geolocation=()');
    expect(h['x-powered-by']).toBeUndefined();
    // HSTS uniquement en production (voir production.test.ts).
    expect(h['strict-transport-security']).toBeUndefined();
  });

  it('les en-têtes sont aussi présents sur les refus (401, 404)', async () => {
    const browser = new Browser(app, uniqueIp());
    for (const res of [await browser.get('/api/test/protected'), await browser.get('/page-inconnue')]) {
      expect(res.raw.headers['content-security-policy']).toBeDefined();
      expect(res.raw.headers['x-content-type-options']).toBe('nosniff');
    }
  });
});

describe('session obligatoire par défaut', () => {
  it('route protégée sans session → 401 UNAUTHENTICATED', async () => {
    const res = await new Browser(app, uniqueIp()).get('/api/test/protected');
    expect(res.status).toBe(401);
    expect(res.errorCode).toBe('UNAUTHENTICATED');
  });

  it('les routes inconnues sous /api ne révèlent rien sans session (401 comme une route existante)', async () => {
    const browser = new Browser(app, uniqueIp());
    const unknown = await browser.get('/api/nexiste/pas');
    const existing = await browser.get('/api/test/protected');
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(existing.body);
    expect((await browser.get('/api')).status).toBe(401);
    expect((await browser.get('/API/test/protected')).status).toBe(401);
    expect((await browser.post('/api/nexiste/pas', {})).status).toBe(401);
    expect((await browser.request('DELETE', '/api/test/protected')).status).toBe(401);
    // Hors /api, une page inconnue est un simple 404 (interface non compilée dans les tests).
    expect((await browser.get('/page-inconnue')).status).toBe(404);

    await browser.login(alice);
    const authed = await browser.get('/api/nexiste/pas');
    expect(authed.status).toBe(404);
    expect(authed.errorCode).toBe('NOT_FOUND');
  });

  it('une route `public` est accessible sans session ; la sonde de santé aussi', async () => {
    const browser = new Browser(app, uniqueIp());
    const res = await browser.get<{ authenticated: boolean }>('/api/test/public');
    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(false);
    expect((await browser.get('/api/health')).status).toBe(200);
  });

  it('l’authentification passe avant la validation du corps', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/test/mutate',
      remoteAddress: uniqueIp(),
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: '{ceci n’est pas du JSON',
    });
    expect(res.statusCode).toBe(401);
  });

  it('aucune route HTTP ne crée, liste ni supprime de compte', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.login(alice);
    await browser.stepUp(alice);
    for (const url of ['/api/users', '/api/auth/register', '/api/auth/users', '/api/security/users', '/api/admins', '/api/auth/signup']) {
      expect((await browser.get(url)).status).toBe(404);
      expect((await browser.post(url, { username: 'mallory', email: 'm@exemple.test', password: 'Tr3s-Solide!Phrase-99-Zq' })).status).toBe(404);
      expect((await browser.delete(`${url}/1`)).status).toBe(404);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
  });
});

describe('CSRF', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = new Browser(app, uniqueIp());
    await browser.login(alice);
  });

  it('mutation avec Origin et jeton corrects → acceptée', async () => {
    const res = await browser.post<{ body: unknown }>('/api/test/mutate', { a: 1 });
    expect(res.status).toBe(200);
    expect(res.body.data.body).toEqual({ a: 1 });
  });

  it('mutation sans jeton CSRF → 403 CSRF_INVALID', async () => {
    const res = await browser.post('/api/test/mutate', { a: 1 }, { csrf: null });
    expect(res.status).toBe(403);
    expect(res.errorCode).toBe('CSRF_INVALID');
  });

  it('mutation avec un mauvais jeton (ou celui d’une autre session) → 403', async () => {
    expect((await browser.post('/api/test/mutate', {}, { csrf: 'x'.repeat(43) })).status).toBe(403);
    expect((await browser.post('/api/test/mutate', {}, { csrf: '' })).status).toBe(403);
    const other = new Browser(app, uniqueIp());
    const session = await other.login(alice);
    const res = await browser.post('/api/test/mutate', {}, { csrf: session.csrfToken! });
    expect(res.status).toBe(403);
    expect(res.errorCode).toBe('CSRF_INVALID');
  });

  it('mutation avec une mauvaise Origin, ou sans Origin → 403, même avec le bon jeton', async () => {
    for (const origin of ['https://evil.test', 'https://panel.test.evil.test', 'http://panel.test', 'https://panel.test:8443', 'https://PANEL.test/', 'null', null]) {
      const res = await browser.post('/api/test/mutate', {}, { origin });
      expect(res.status, `origin ${origin}`).toBe(403);
      expect(res.errorCode).toBe('CSRF_INVALID');
    }
    // Un Referer correct ne remplace pas Origin.
    const referer = await browser.post('/api/test/mutate', {}, { origin: null, headers: { referer: `${ORIGIN}/` } });
    expect(referer.status).toBe(403);
  });

  it('PUT, PATCH et DELETE sont soumis au même contrôle', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const res = await browser.request(method, '/api/security/sessions/00000000-0000-4000-8000-000000000000', { csrf: null });
      expect(res.status, method).toBe(403);
    }
  });

  it('les rejets CSRF d’une session ouverte sont journalisés', () => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'security.csrf.rejected' AND user_id = ? AND success = 0").get(alice.user.id) as { n: number };
    expect(n).toBeGreaterThanOrEqual(5);
  });

  it('les routes publiques de connexion exigent la bonne Origin', async () => {
    const anonymous = new Browser(app, uniqueIp());
    const evil = await anonymous.post('/api/auth/login', { identifier: 'alice', password: alice.password }, { origin: 'https://evil.test' });
    expect(evil.status).toBe(403);
    expect(evil.errorCode).toBe('CSRF_INVALID');
    const none = await anonymous.post('/api/auth/login', { identifier: 'alice', password: alice.password }, { origin: null });
    expect(none.status).toBe(403);
    expect(anonymous.cookies.size).toBe(0);
  });

  it('`skipCsrf` (webhook signé) dispense d’Origin et de jeton', async () => {
    const res = await new Browser(app, uniqueIp()).post('/api/test/webhook', { x: 1 }, { origin: null, csrf: null });
    expect(res.status).toBe(200);
  });

  it('la déconnexion exige le jeton CSRF', async () => {
    const victim = new Browser(app, uniqueIp());
    await victim.login(alice);
    expect((await victim.post('/api/auth/logout', {}, { csrf: null })).status).toBe(403);
    expect((await victim.get('/api/test/protected')).status).toBe(200);
  });
});

describe('step-up', () => {
  it('route `stepUp` : refusée sans confirmation récente, acceptée après POST /api/auth/step-up', async () => {
    const browser = new Browser(app, uniqueIp());
    const session = await browser.login(alice);
    // La connexion vient de vérifier le TOTP : la fenêtre de step-up est ouverte pour STEP_UP_MINUTES.
    expect(session.stepUpUntil).not.toBeNull();
    expect((await browser.post('/api/test/critical')).status).toBe(200);

    advance(5 * MIN + 1000);
    const refused = await browser.post('/api/test/critical');
    expect(refused.status).toBe(403);
    expect(refused.errorCode).toBe('STEP_UP_REQUIRED');
    expect((await browser.get<SessionState>('/api/auth/session')).body.data.stepUpUntil).toBeNull();
    // Les routes ordinaires restent accessibles.
    expect((await browser.post('/api/test/mutate')).status).toBe(200);

    // Mauvais code : refusé, la fenêtre reste fermée.
    const wrong = await browser.post('/api/auth/step-up', { totpCode: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.errorCode).toBe('INVALID_CREDENTIALS');
    expect((await browser.post('/api/test/critical')).status).toBe(403);

    const code = freshTotp(alice.totpSecret);
    const ok = await browser.post<StepUpResponse>('/api/auth/step-up', { totpCode: code });
    expect(ok.status).toBe(200);
    expect(new Date(ok.body.data.stepUpUntil).getTime()).toBe(Date.now() + 5 * MIN);
    expect((await browser.post('/api/test/critical')).status).toBe(200);
    expect((await browser.get<SessionState>('/api/auth/session')).body.data.stepUpUntil).toBe(ok.body.data.stepUpUntil);

    // Anti-rejeu : le même code ne rouvre pas une fenêtre (ni ici, ni depuis une autre session).
    advance(1000);
    const replay = await browser.post('/api/auth/step-up', { totpCode: code });
    expect(replay.status).toBe(401);

    // La fenêtre se referme après STEP_UP_MINUTES.
    advance(5 * MIN);
    expect((await browser.post('/api/test/critical')).errorCode).toBe('STEP_UP_REQUIRED');
    db.prepare('UPDATE users SET failed_attempts = 0').run();
  });

  it('le step-up est propre à la session', async () => {
    const a = new Browser(app, uniqueIp());
    const b = new Browser(app, uniqueIp());
    await a.login(alice);
    await b.login(alice);
    advance(5 * MIN + 1000);
    expect((await a.stepUp(alice)).status).toBe(200);
    expect((await a.post('/api/test/critical')).status).toBe(200);
    expect((await b.post('/api/test/critical')).errorCode).toBe('STEP_UP_REQUIRED');
  });

  it('le step-up exige une session et le jeton CSRF', async () => {
    const anonymous = new Browser(app, uniqueIp());
    expect((await anonymous.post('/api/auth/step-up', { totpCode: totpCode(alice.totpSecret) })).status).toBe(401);
    expect((await anonymous.post('/api/test/critical')).status).toBe(401);
  });
});

describe('expiration des sessions', () => {
  it('inactivité : la session expire après SESSION_IDLE_MINUTES sans requête', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.login(alice);
    advance(14 * MIN);
    expect((await browser.get('/api/test/protected')).status).toBe(200);
    // L'activité a prolongé la session.
    advance(14 * MIN);
    expect((await browser.get('/api/test/protected')).status).toBe(200);
    advance(15 * MIN + 1000);
    const expired = await browser.get('/api/test/protected');
    expect(expired.status).toBe(401);
    expect(expired.errorCode).toBe('UNAUTHENTICATED');
    // Une fois expirée, elle ne revient pas.
    expect((await browser.get<SessionState>('/api/auth/session')).body.data.authenticated).toBe(false);
  });

  it('les requêtes d’arrière-plan (X-TC-Background ou route `background`) ne prolongent pas la session', async () => {
    const header = new Browser(app, uniqueIp());
    const route = new Browser(app, uniqueIp());
    const control = new Browser(app, uniqueIp());
    await header.login(alice);
    await route.login(alice);
    await control.login(alice);
    const start = Date.now();
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE revoked_at IS NULL').run(start);

    advance(10 * MIN);
    expect((await header.get('/api/test/protected', { 'x-tc-background': '1' })).status).toBe(200);
    expect((await route.get('/api/test/background')).status).toBe(200);
    expect((await control.get('/api/test/protected')).status).toBe(200);

    advance(6 * MIN);
    expect((await header.get('/api/test/protected')).status).toBe(401);
    expect((await route.get('/api/test/protected')).status).toBe(401);
    expect((await control.get('/api/test/protected')).status).toBe(200);
  });

  it('seules les requêtes du panel ayant passé tous les contrôles prolongent la session (Sec-Fetch-Site, CSRF)', async () => {
    const sameOrigin = new Browser(app, uniqueIp());
    const crossSite = new Browser(app, uniqueIp());
    const refused = new Browser(app, uniqueIp());
    await sameOrigin.login(alice);
    await crossSite.login(alice);
    await refused.login(alice);
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE revoked_at IS NULL').run(Date.now());

    advance(10 * MIN);
    expect((await sameOrigin.get('/api/test/protected', { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await crossSite.get('/api/test/protected', { 'sec-fetch-site': 'cross-site' })).status).toBe(200);
    expect((await refused.post('/api/test/mutate', {}, { csrf: null })).status).toBe(403);

    advance(6 * MIN);
    expect((await sameOrigin.get('/api/test/protected')).status).toBe(200);
    expect((await crossSite.get('/api/test/protected')).status).toBe(401);
    expect((await refused.get('/api/test/protected')).status).toBe(401);
  });

  it('expiration absolue : même active en continu, la session s’arrête après SESSION_MAX_HOURS', async () => {
    const browser = new Browser(app, uniqueIp());
    const session = await browser.login(alice);
    const expiresAt = new Date(session.expiresAt!).getTime();
    expect(expiresAt).toBe(Date.now() + 8 * 60 * MIN);
    while (Date.now() + 10 * MIN < expiresAt) {
      advance(10 * MIN);
      const res = await browser.get('/api/test/protected');
      if (res.status !== 200) throw new Error(`session perdue trop tôt : ${res.status}`);
    }
    advance(10 * MIN);
    expect((await browser.get('/api/test/protected')).status).toBe(401);
  });

  it('déconnexion : le cookie de session rejoué ne fonctionne plus', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.login(alice);
    const stolen = browser.cookies.get('tc_session')!;
    expect((await browser.post('/api/auth/logout')).status).toBe(200);
    const thief = new Browser(app, browser.ip);
    thief.cookies.set('tc_session', stolen);
    expect((await thief.get('/api/test/protected')).status).toBe(401);
    expect((await thief.get<SessionState>('/api/auth/session')).body.data.authenticated).toBe(false);
  });
});

describe('liste blanche d’IP', () => {
  afterEach(() => setPanelAllowlist([], null));

  it('entrées : IPv4, IPv6, CIDR et IPv4 mappée en IPv6', () => {
    expect(normalizeAllowlistEntry(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(normalizeAllowlistEntry('203.0.113.0/24')).toBe('203.0.113.0/24');
    expect(normalizeAllowlistEntry('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeAllowlistEntry('::ffff:203.0.113.0/120')).toBe('203.0.113.0/24');
    expect(normalizeAllowlistEntry('2001:DB8::/32')).toBe('2001:db8::/32');
    expect(normalizeAllowlistEntry('2001:db8::1')).toBe('2001:db8::1');
    for (const bad of ['', 'exemple.com', '203.0.113.300', '203.0.113.0/33', '0.0.0.0/0', '::/0', '1.2.3', '010.0.0.1', '0x7f.0.0.1', '010.0.0.0/8', '1.2/16', '::ffff:010.0.0.1', '::ffff:010.0.0.0/120', '10.0.0.1; DROP', '203.0.113.7/abc']) {
      expect(normalizeAllowlistEntry(bad), bad).toBeNull();
    }
    expect(ipMatchesEntries('203.0.113.7', ['203.0.113.0/24'])).toBe(true);
    expect(ipMatchesEntries('::ffff:203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(ipMatchesEntries('203.0.114.7', ['203.0.113.0/24'])).toBe(false);
    expect(ipMatchesEntries('2001:db8:1::5', ['2001:db8::/32'])).toBe(true);
    expect(ipMatchesEntries('2001:db9::5', ['2001:db8::/32'])).toBe(false);
    expect(ipMatchesEntries('203.0.113.7', [])).toBe(false);
    expect(ipMatchesEntries('pas-une-ip', ['203.0.113.0/24'])).toBe(false);
    expect(ipRateKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(ipRateKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('liste non vide : toute IP hors liste reçoit 403 IP_NOT_ALLOWED, sur toutes les routes', async () => {
    const inside = new Browser(app, '203.0.113.7');
    const outside = new Browser(app, '198.18.0.9');
    await inside.login(alice);
    await outside.login(alice);

    setPanelAllowlist(['203.0.113.0/24', '2001:db8:aa::/48'], null);

    expect((await inside.get('/api/test/protected')).status).toBe(200);
    // Même avec une session valide, l'IP hors liste est refusée — y compris sur les routes publiques et inconnues.
    for (const url of ['/api/test/protected', '/api/auth/session', '/api/test/public', '/api/nexiste/pas', '/', '/page']) {
      const res = await outside.get(url);
      expect(res.status, url).toBe(403);
      expect(res.errorCode).toBe('IP_NOT_ALLOWED');
    }
    const login = await new Browser(app, '198.18.0.10').post('/api/auth/login', { identifier: 'alice', password: alice.password });
    expect(login.status).toBe(403);
    expect(login.errorCode).toBe('IP_NOT_ALLOWED');

    // IPv4 mappée en IPv6 et IPv6 dans un CIDR autorisé.
    expect((await new Browser(app, '::ffff:203.0.113.99').get('/api/auth/session')).status).toBe(200);
    expect((await new Browser(app, '::ffff:198.18.0.9').get('/api/auth/session')).status).toBe(403);
    expect((await new Browser(app, '2001:db8:aa:1::42').get('/api/auth/session')).status).toBe(200);
    expect((await new Browser(app, '2001:db8:bb::42').get('/api/auth/session')).status).toBe(403);

    // Dérogations explicites : webhook (filtre propre) et sonde de santé.
    expect((await outside.post('/api/test/webhook', {}, { origin: null, csrf: null })).status).toBe(200);
    expect((await outside.get('/api/health')).status).toBe(200);

    // Liste vidée : le filtrage est désactivé.
    setPanelAllowlist([], null);
    expect((await outside.get('/api/test/protected')).status).toBe(200);
  });

  it('les rejets sont journalisés avec modération (pas une ligne par requête)', async () => {
    setPanelAllowlist(['203.0.113.0/24'], null);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'security.ip_allowlist.rejected'").get() as { n: number }).n;
    const scanner = new Browser(app, '198.18.7.7');
    for (let i = 0; i < 20; i += 1) expect((await scanner.get('/api/auth/session')).status).toBe(403);
    const rows = db.prepare("SELECT target, user_id, success FROM audit_log WHERE action = 'security.ip_allowlist.rejected' AND target = '198.18.7.7'").all();
    expect(rows).toEqual([{ target: '198.18.7.7', user_id: null, success: 0 }]);
    const after = (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'security.ip_allowlist.rejected'").get() as { n: number }).n;
    expect(after - before).toBe(1);
    // Passé le délai, un nouveau rejet est de nouveau journalisé.
    advance(10 * MIN + 1000);
    await scanner.get('/api/auth/session');
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'security.ip_allowlist.rejected' AND target = '198.18.7.7'").get()).toEqual({ n: 2 });
  });
});
