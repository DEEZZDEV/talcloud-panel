/**
 * AUDIT 3 (intégrations) — webhook WHMCS : points VÉRIFIÉS (aucun défaut).
 *
 * Piste écartée : le hook PHP tronque en points de code (mb_substr) et le panel borne avec zod .max(), qui
 * (zod 4.6) compte lui aussi en points de code au-delà de la limite en unités UTF-16 : un nom de client fait
 * d'émojis n'est donc PAS refusé. Ces tests le confirment, ainsi que le refus uniforme (401, jamais 500)
 * des corps démesurés envoyés en flux, sans en-tête de type, ou compressés.
 */
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { HOOK_SECRET } = vi.hoisted(() => {
  const secret = 'secret-webhook-audit3-0123456789-abcdefghijklmnop';
  process.env.WHMCS_HOOK_SECRET = secret;
  process.env.WHMCS_HOOK_IPS = '';
  return { HOOK_SECRET: secret };
});

import { db } from '../src/db/index.js';
import { flushNotifications } from '../src/modules/notifications/service.js';
import { buildTestApp, useFakeClock } from './helpers.js';

let app: FastifyInstance;
let ipCounter = 0;

const LINE_BREAK = new RegExp(['\\r\\n', '\\n', '\\r', '\\u2028', '\\u2029'].join('|'));
const CONTROLS = new RegExp('[\\x00-\\x1f\\x7f]+', 'g');

/** Reproduit talcloud_notify_text() : première ligne, contrôles retirés, mb_substr en points de code. */
const phpText = (value: string, max: number): string =>
  [...value.split(LINE_BREAK)[0]!.replace(CONTROLS, ' ').trim()].slice(0, max).join('');

async function sendSigned(payload: Record<string, unknown>) {
  // Même encodage que json_encode(JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES).
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `sha256=${createHmac('sha256', HOOK_SECRET).update(`${timestamp}.`).update(body).digest('hex')}`;
  ipCounter += 1;
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/whmcs',
    headers: { 'content-type': 'application/json', 'x-talcloud-timestamp': String(timestamp), 'x-talcloud-signature': signature },
    payload: body,
    remoteAddress: `203.0.113.${ipCounter}`,
  });
}

const notificationFor = (orderId: number) =>
  db.prepare("SELECT title FROM notifications WHERE type IN ('order','payment') AND data LIKE ?").get(`%"orderId":${orderId},%`) as { title: string } | undefined;

beforeAll(async () => {
  useFakeClock();
  app = await buildTestApp();
});

afterAll(async () => {
  await flushNotifications();
  await app.close();
});

describe('vérifié — contrat de longueur hook PHP / panel (points de code des deux côtés)', () => {
  it('contrôle : le même évènement avec un nom ordinaire est accepté et notifié', async () => {
    const res = await sendSigned({
      eventId: 'order_created:9001', event: 'order_created', orderId: 9001, invoiceId: 19001, clientId: 77,
      clientName: phpText('Jean Dupont', 150), products: ['VPS 4 Go'], amount: 12, currency: 'EUR', gateway: 'stripe',
    });
    expect(res.statusCode).toBe(200);
    expect(notificationFor(9001)).toBeDefined();
  });

  it('nom de 150 émojis (tel que le hook le tronque et l’envoie) : la commande doit être notifiée, pas refusée en 400', async () => {
    const clientName = phpText('🦊'.repeat(400), 150); // firstname + lastname + société saisis par le client
    expect([...clientName].length).toBe(150); // ce que le hook envoie réellement
    const res = await sendSigned({
      eventId: 'order_created:9002', event: 'order_created', orderId: 9002, invoiceId: 19002, clientId: 78,
      clientName, products: ['VPS 4 Go'], amount: 12, currency: 'EUR', gateway: 'stripe',
    });
    expect(res.statusCode, 'le panel refuse une charge utile produite par le hook officiel').toBe(200);
    expect(notificationFor(9002)).toBeDefined();
  });

  it('libellé de facture (domaine saisi par le client) de 150 caractères hors BMP : paiement notifié', async () => {
    const res = await sendSigned({
      eventId: 'invoice_paid:9003', event: 'invoice_paid', orderId: 9003, invoiceId: 19003, clientId: 79,
      clientName: 'Client normal', products: [phpText(`Hébergement - ${'𝕏'.repeat(200)}.com`, 150)], amount: 5, currency: 'EUR', gateway: 'paypal',
    });
    expect(res.statusCode).toBe(200);
    expect(notificationFor(9003)).toBeDefined();
  });
});

describe('vérifié — webhook : formes de corps inhabituelles', () => {
  const headersFor = (body: Buffer | string, extra: Record<string, string> = {}) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = `sha256=${createHmac('sha256', HOOK_SECRET).update(`${timestamp}.`).update(body).digest('hex')}`;
    return { 'x-talcloud-timestamp': String(timestamp), 'x-talcloud-signature': signature, ...extra };
  };

  it('corps signé de 1 Mo envoyé sans Content-Length (flux) : 401 uniforme, aucun 500', async () => {
    const { Readable } = await import('node:stream');
    const big = Buffer.alloc(1024 * 1024, 0x61);
    ipCounter += 1;
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/whmcs',
      headers: headersFor(big, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }),
      payload: Readable.from([big.subarray(0, 512 * 1024), big.subarray(512 * 1024)]),
      remoteAddress: `203.0.113.${ipCounter}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('corps gzip signé (Content-Encoding ignoré, jamais décompressé) : refusé proprement, pas de 500', async () => {
    const { gzipSync } = await import('node:zlib');
    const gz = gzipSync(JSON.stringify({ eventId: 'order_created:9100', event: 'order_created', clientName: 'X', products: [], amount: 1, currency: 'EUR' }));
    ipCounter += 1;
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/whmcs',
      headers: headersFor(gz, { 'content-type': 'application/json', 'content-encoding': 'gzip' }),
      payload: gz,
      remoteAddress: `203.0.113.${ipCounter}`,
    });
    expect([400, 401, 415]).toContain(res.statusCode);
    expect(db.prepare('SELECT 1 FROM webhook_events WHERE event_id = ?').get('order_created:9100')).toBeUndefined();
  });
});
