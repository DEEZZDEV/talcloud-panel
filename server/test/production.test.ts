import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Comportements propres à NODE_ENV=production : HTTPS obligatoire, contrôle de l'en-tête Host, HSTS,
 * cookies « __Host- ». L'environnement est posé AVANT l'import (dynamique) de l'application.
 * Le proxy inverse de confiance est simulé par 10.0.0.2 (TRUST_PROXY) et son en-tête X-Forwarded-Proto.
 */
process.env.NODE_ENV = 'production';
process.env.PUBLIC_URL = 'https://panel.exemple.test';
process.env.TRUST_PROXY = '10.0.0.2';
process.env.SMTP_HOST = 'smtp.invalide.test';
process.env.SMTP_FROM = 'panel@exemple.test';
process.env.LOG_LEVEL = 'silent';

const PROXY = '10.0.0.2';
const HOST = 'panel.exemple.test';
const ORIGIN = 'https://panel.exemple.test';

let app: FastifyInstance;

const viaProxy = (headers: Record<string, string> = {}) => ({ host: HOST, 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9', ...headers });

beforeAll(async () => {
  const { buildApp } = await import('../src/app.js');
  app = await buildApp();
  app.post('/api/test/public-post', { config: { public: true } }, async () => ({ data: { ok: true } }));
  app.get('/api/test/whoami', { config: { public: true } }, async (request) => ({ data: request.client }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('production', () => {
  it('HTTPS via le proxy de confiance : accepté, avec HSTS', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/session', remoteAddress: PROXY, headers: viaProxy() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('HTTP en clair : GET → 308 vers PUBLIC_URL, autres méthodes → 403', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/auth/session?x=1', remoteAddress: PROXY, headers: viaProxy({ 'x-forwarded-proto': 'http' }) });
    expect(get.statusCode).toBe(308);
    expect(get.headers.location).toBe('https://panel.exemple.test/api/auth/session?x=1');

    const page = await app.inject({ method: 'GET', url: '//evil.test/chemin', remoteAddress: PROXY, headers: viaProxy({ 'x-forwarded-proto': 'http' }) });
    expect(page.statusCode).toBe(308);
    expect(String(page.headers.location).startsWith('https://panel.exemple.test/')).toBe(true);

    const post = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: PROXY,
      headers: viaProxy({ 'x-forwarded-proto': 'http', origin: ORIGIN }),
      payload: { identifier: 'a', password: 'b' },
    });
    expect(post.statusCode).toBe(403);
    expect(post.json().error.code).toBe('FORBIDDEN');
  });

  it('X-Forwarded-Proto venant d’un client non approuvé est ignoré', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/session', remoteAddress: '198.51.100.77', headers: { host: HOST, 'x-forwarded-proto': 'https' } });
    expect(res.statusCode).toBe(308);
    // Et son X-Forwarded-For ne change pas l'IP retenue.
    const whoami = await app.inject({ method: 'POST', url: '/api/test/public-post', remoteAddress: '198.51.100.77', headers: { host: HOST, 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9', origin: ORIGIN } });
    expect(whoami.statusCode).toBe(403);
  });

  it('l’IP de l’appelant est celle transmise par le proxy de confiance', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test/whoami', remoteAddress: PROXY, headers: viaProxy({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }) });
    expect(res.json().data.ip).toBe('203.0.113.9');
  });

  it('en-tête Host différent de celui de PUBLIC_URL : refusé', async () => {
    for (const host of ['evil.test', 'panel.exemple.test.evil.test', 'panel.exemple.test:8080', '127.0.0.1:8080', 'localhost']) {
      const res = await app.inject({ method: 'GET', url: '/api/auth/session', remoteAddress: PROXY, headers: viaProxy({ host }) });
      expect(res.statusCode, host).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
    const page = await app.inject({ method: 'GET', url: '/', remoteAddress: PROXY, headers: viaProxy({ host: 'evil.test' }) });
    expect(page.statusCode).toBe(403);
  });

  it('exception : la sonde de santé locale (HTTP, Host local) reste accessible, et elle seule', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:8080' } });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ data: { status: 'ok' } });
    const other = await app.inject({ method: 'GET', url: '/api/auth/session', remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:8080' } });
    expect(other.statusCode).toBe(403);
    const postHealth = await app.inject({ method: 'POST', url: '/api/health', remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:8080' } });
    expect(postHealth.statusCode).toBe(403);
  });

  it('cookies « __Host- » : Secure, HttpOnly, SameSite=Strict, Path=/, sans Domain', async () => {
    const { SESSION_COOKIE, CHALLENGE_COOKIE, DEVICE_COOKIE, cookieOptions } = await import('../src/modules/auth/sessions.js');
    expect(SESSION_COOKIE).toBe('__Host-tc_session');
    expect(CHALLENGE_COOKIE).toBe('__Host-tc_login');
    expect(DEVICE_COOKIE).toBe('__Host-tc_device');
    expect(cookieOptions).toEqual({ httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
    expect('domain' in cookieOptions).toBe(false);
  });

  it('configuration : PUBLIC_URL en http:// est refusée en production', async () => {
    const { execFileSync } = await import('node:child_process');
    const { resolve, join } = await import('node:path');
    const serverDir = resolve(import.meta.dirname, '..');
    const run = () =>
      execFileSync(process.execPath, [join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '-e', "import('./src/config.ts')"], {
        cwd: serverDir,
        env: { ...process.env, PUBLIC_URL: 'http://panel.exemple.test' },
        stdio: 'pipe',
      });
    expect(run).toThrow(/PUBLIC_URL doit être en https/);
  });
});
