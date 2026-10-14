import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // Aucun secret : le webhook est désactivé (une variable vide est traitée comme absente par config.ts).
  process.env.WHMCS_HOOK_SECRET = '';
  process.env.WHMCS_HOOK_IPS = '';
});

import { config } from '../src/config.js';
import { db } from '../src/db/index.js';
import { buildTestApp, useFakeClock } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  useFakeClock();
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('webhook WHMCS sans WHMCS_HOOK_SECRET', () => {
  it('la route répond 404, quelle que soit la requête, et ne crée rien', async () => {
    expect(config.whmcsHookSecret).toBeNull();
    const body = JSON.stringify({ eventId: 'order_created:1', event: 'order_created', clientName: 'Jean Dupont', products: ['Minecraft 8 Go'], amount: 12, currency: 'EUR' });
    const timestamp = String(Math.floor(Date.now() / 1000));

    const attempts = [
      { 'x-talcloud-timestamp': timestamp, 'x-talcloud-signature': `sha256=${createHmac('sha256', '').update(`${timestamp}.${body}`).digest('hex')}` },
      { 'x-talcloud-timestamp': timestamp, 'x-talcloud-signature': `sha256=${createHmac('sha256', 'null').update(`${timestamp}.${body}`).digest('hex')}` },
      { 'x-talcloud-timestamp': timestamp, 'x-talcloud-signature': `sha256=${'0'.repeat(64)}` },
      {},
    ];
    for (const headers of attempts) {
      const res = await app.inject({ method: 'POST', url: '/api/webhooks/whmcs', headers: { 'content-type': 'application/json', ...headers }, payload: body, remoteAddress: '203.0.113.9' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Ressource introuvable' } });
    }
    expect((db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM webhook_events').get() as { c: number }).c).toBe(0);
  });
});
