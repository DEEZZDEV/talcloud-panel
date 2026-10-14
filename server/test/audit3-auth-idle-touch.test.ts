/**
 * AUDIT 3 (authentification) — C-03 : une requête REFUSÉE prolonge quand même la session.
 *
 * plugin.ts:214-217 appelle `touchSession` (étape 6) AVANT le contrôle CSRF / Origin (étape 7) : une requête
 * modifiante rejetée en 403 CSRF_INVALID repousse l'expiration d'inactivité. De même, aucune requête n'est
 * distinguée selon `Sec-Fetch-Site` : une requête « same-site » (émise par une page d'un AUTRE sous-domaine du même
 * domaine enregistrable — site client, WHMCS, blog… — à qui SameSite=Strict laisse passer les cookies) prolonge
 * la session comme une action de l'administrateur. Un onglet laissé ouvert sur une telle page garde ainsi une
 * session inactive vivante jusqu'à l'expiration absolue (8 h au lieu de 15 min).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/index.js';
import { advance, Browser, buildTestApp, createTestAdmin, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

let app: FastifyInstance;
let alice: TestAdmin;

beforeAll(async () => {
  useFakeClock();
  app = await buildTestApp();
  alice = await createTestAdmin('alice');
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  advance(26 * 3600_000);
  db.exec('DELETE FROM auth_failures; DELETE FROM auth_ip_blocks; DELETE FROM login_challenges;');
});

const MIN = 60_000;

describe('C-03 — l’expiration d’inactivité est repoussée par des requêtes qui ne viennent pas du panel', () => {
  it('une requête modifiante refusée (Origin étrangère → 403 CSRF) ne prolonge pas la session', async () => {
    const admin = new Browser(app, uniqueIp());
    await admin.login(alice);

    advance(14 * MIN);
    const forged = await admin.post('/api/test/mutate', { x: 1 }, { origin: 'https://site-client.panel.test', csrf: null });
    expect(forged.errorCode).toBe('CSRF_INVALID');

    advance(2 * MIN); // 16 min sans activité réelle de l'administrateur
    const later = await admin.get('/api/test/protected', { 'x-tc-background': '1' });
    expect(later.status, 'la session a été prolongée par la requête refusée').toBe(401);
  });

  it('une requête GET « same-site » (autre sous-domaine) ne prolonge pas la session', async () => {
    const admin = new Browser(app, uniqueIp());
    await admin.login(alice);

    advance(14 * MIN);
    // Ce qu'envoie le navigateur pour <img src="https://panel…/api/auth/session"> posé sur un sous-domaine voisin.
    await admin.get('/api/auth/session', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' });

    advance(2 * MIN);
    const later = await admin.get('/api/test/protected', { 'x-tc-background': '1' });
    expect(later.status, 'la session a été prolongée par une requête émise depuis un autre site').toBe(401);
  });

  it('vérifié — une requête d’arrière-plan (X-TC-Background) ne prolonge pas la session', async () => {
    const admin = new Browser(app, uniqueIp());
    await admin.login(alice);
    advance(14 * MIN);
    expect((await admin.get('/api/test/protected', { 'x-tc-background': '1' })).status).toBe(200);
    advance(2 * MIN);
    expect((await admin.get('/api/test/protected', { 'x-tc-background': '1' })).status).toBe(401);
  });
});
