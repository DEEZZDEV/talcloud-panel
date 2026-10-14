import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GameServer, PterodactylSummary, SettingsTestResult, SettingsView, WhmcsClientRef } from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db/index.js';
import { parseRetryAfter } from '../src/modules/pterodactyl/client.js';
import { invalidateCache, normalizeState } from '../src/modules/pterodactyl/servers.js';
import { advance, Browser, buildTestApp, createTestAdmin, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

// Le corps de findClientsByEmails est écrit par un autre module : on le remplace ici pour tester le lien par e-mail.
const whmcs = vi.hoisted(() => ({ findClientsByEmails: vi.fn<(emails: string[]) => Promise<Map<string, unknown>>>() }));
vi.mock('../src/modules/whmcs/service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findClientsByEmails: whmcs.findClientsByEmails,
}));

const APP_KEY ='ptla_TestApplicationKey0123456789abcdefABCDEF01';
const CLIENT_KEY = 'ptlc_TestClientKey0123456789abcdefABCDEF0123456';

// ───────────────────────────── Faux panel Pterodactyl (HTTP local) ─────────────────────────────

type Live = { state: string; cpu: number; memory: number; disk: number; uptime: number; isSuspended?: boolean } | { fail: number } | 'reset';

interface FakeServer {
  id: number;
  identifier: string;
  name: string;
  description: string;
  status: string | null;
  suspended: boolean;
  node: { id: number; name: string } | null;
  user: { id: number; username: string; email: string } | null;
  limits: { memory: number; disk: number; cpu: number };
  live: Live;
}

interface Recorded {
  method: string;
  path: string;
  query: string;
  auth: string | undefined;
  accept: string | undefined;
  body: string;
}

const running = (cpu = 12.345): Live => ({ state: 'running', cpu, memory: 512 * 1024 * 1024, disk: 2_000_000_000, uptime: 3_600_000 });

function defaultServers(): FakeServer[] {
  const node1 = { id: 1, name: 'node-paris' };
  const node2 = { id: 2, name: 'node-lyon' };
  const base = { description: '', status: null, suspended: false, limits: { memory: 2048, disk: 10240, cpu: 200 } };
  return [
    { ...base, id: 1, identifier: 'aaaa1111', name: 'Survie', node: node1, user: { id: 10, username: 'alice', email: 'Alice@Client.test' }, live: running() },
    { ...base, id: 2, identifier: 'bbbb2222', name: 'Créatif', node: node1, user: { id: 11, username: 'bob', email: 'bob@client.test' }, live: { state: 'offline', cpu: 0, memory: 0, disk: 500, uptime: 0 } },
    { ...base, id: 3, identifier: 'cccc3333', name: 'Suspendu', suspended: true, status: 'suspended', node: node2, user: { id: 10, username: 'alice', email: 'alice@client.test' }, live: { fail: 409 } },
    { ...base, id: 4, identifier: 'dddd4444', name: 'Installation', status: 'installing', node: node2, user: null, live: { fail: 409 } },
    { ...base, id: 5, identifier: 'eeee5555', name: '<script>alert(1)</script>', description: '<img src=x onerror=alert(1)>', node: null, user: { id: 12, username: 'carol', email: 'carol@client.test' }, limits: { memory: 0, disk: 0, cpu: 0 }, live: { fail: 502 } },
  ];
}

const panel = {
  servers: [] as FakeServer[],
  /** Taille de page imposée par le faux panel, quel que soit per_page : force le client à suivre la pagination. */
  pageSize: 2,
  requests: [] as Recorded[],
  /** Réponses 429 restantes par préfixe de chemin. */
  rateLimits: [] as { prefix: string; remaining: number; retryAfter: string | null }[],
  clientAdmin: true,
  failActions: 0 as number,
  reset() {
    this.servers = defaultServers();
    this.pageSize = 2;
    this.requests = [];
    this.rateLimits = [];
    this.clientAdmin = true;
    this.failActions = 0;
  },
  count(method: string, pattern: RegExp) {
    return this.requests.filter((r) => r.method === method && pattern.test(r.path)).length;
  },
};

function serverObject(s: FakeServer) {
  return {
    object: 'server',
    attributes: {
      id: s.id,
      external_id: null,
      uuid: `00000000-0000-4000-8000-00000000000${s.id}`,
      identifier: s.identifier,
      name: s.name,
      description: s.description,
      status: s.status,
      suspended: s.suspended,
      limits: { ...s.limits, swap: 0, io: 500, threads: null, oom_disabled: true },
      user: s.user?.id ?? 0,
      node: s.node?.id ?? 99,
      // Champ sensible réellement renvoyé par Pterodactyl : ne doit jamais ressortir du panel.
      container: { startup_command: 'java -jar server.jar', environment: { RCON_PASSWORD: 'rcon-secret-upstream' } },
      relationships: {
        user: s.user ? { object: 'user', attributes: { ...s.user, first_name: 'X', last_name: 'Y', root_admin: false, '2fa': false } } : { object: 'null_resource', attributes: null },
        node: s.node ? { object: 'node', attributes: { ...s.node, fqdn: 'wings.internal.test', daemon_token_id: 'tok' } } : { object: 'null_resource', attributes: null },
      },
    },
  };
}

function handle(req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = new URL(req.url ?? '/', 'http://panel.local');
  const path = url.pathname;
  const auth = req.headers.authorization;
  panel.requests.push({ method: req.method ?? '', path, query: url.search, auth, accept: req.headers.accept, body });

  const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  };
  const error = (status: number) => json(status, { errors: [{ code: 'Upstream', status: String(status), detail: `détail interne rcon-secret-upstream ${auth}` }] });
  const empty = () => {
    res.writeHead(204);
    res.end();
  };

  const limit = panel.rateLimits.find((l) => path.startsWith(l.prefix) && l.remaining > 0);
  if (limit) {
    limit.remaining -= 1;
    return json(429, { errors: [{ code: 'TooManyRequests' }] }, limit.retryAfter === null ? {} : { 'retry-after': limit.retryAfter });
  }

  if (path.startsWith('/api/application/')) {
    if (auth !== `Bearer ${APP_KEY}`) return error(401);
    if (path === '/api/application/servers' && req.method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const slice = panel.servers.slice((page - 1) * panel.pageSize, page * panel.pageSize);
      return json(200, {
        object: 'list',
        data: slice.map(serverObject),
        meta: { pagination: { total: panel.servers.length, count: slice.length, per_page: panel.pageSize, current_page: page, total_pages: Math.max(1, Math.ceil(panel.servers.length / panel.pageSize)), links: {} } },
      });
    }
    const match = /^\/api\/application\/servers\/(\d+)(?:\/(suspend|unsuspend))?$/.exec(path);
    const server = match ? panel.servers.find((s) => s.id === Number(match[1])) : undefined;
    if (!match || !server) return error(404);
    if (!match[2] && req.method === 'GET') return json(200, serverObject(server));
    if (match[2] && req.method === 'POST') {
      if (panel.failActions) return error(panel.failActions);
      server.suspended = match[2] === 'suspend';
      server.status = server.suspended ? 'suspended' : null;
      return empty();
    }
    return error(405);
  }

  if (path.startsWith('/api/client/')) {
    if (auth !== `Bearer ${CLIENT_KEY}`) return error(401);
    if (path === '/api/client/account') return json(200, { object: 'user', attributes: { id: 1, admin: panel.clientAdmin, username: 'root', email: 'root@panel.test' } });
    const match = /^\/api\/client\/servers\/([^/]+)\/(resources|power)$/.exec(path);
    const server = match ? panel.servers.find((s) => s.identifier === match[1]) : undefined;
    if (!match || !server) return error(404);
    if (match[2] === 'resources' && req.method === 'GET') {
      const live = server.live;
      if (live === 'reset') return void req.socket.destroy();
      if ('fail' in live) return error(live.fail);
      return json(200, {
        object: 'stats',
        attributes: {
          current_state: live.state,
          is_suspended: live.isSuspended ?? false,
          resources: { memory_bytes: live.memory, cpu_absolute: live.cpu, disk_bytes: live.disk, network_rx_bytes: 1, network_tx_bytes: 2, uptime: live.uptime },
        },
      });
    }
    if (match[2] === 'power' && req.method === 'POST') {
      if (panel.failActions) return error(panel.failActions);
      return empty();
    }
    return error(405);
  }
  return error(404);
}

let fake: Server;
let panelUrl: string;
let app: FastifyInstance;
let admin: TestAdmin;
/** Session sans re-confirmation TOTP. */
let plain: Browser;
/** Session avec step-up actif. */
let elevated: Browser;

const SECRETS = [APP_KEY, CLIENT_KEY, 'rcon-secret-upstream', 'Bearer '];
function expectNoSecret(value: unknown): void {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRETS) expect(raw).not.toContain(secret);
  expect(raw).not.toContain(panelUrl.replace('http://', '') + '/api/');
}

interface AuditRow {
  action: string;
  target: string | null;
  success: number;
  details: string | null;
  user_id: number | null;
}
const auditRows = (): AuditRow[] => db.prepare("SELECT action, target, success, details, user_id FROM audit_log WHERE action LIKE 'pterodactyl.%' ORDER BY id").all() as AuditRow[];
const clearAudit = () => {
  // Le journal est en ajout seul : on ne le vide pas, on repère simplement le point de départ.
  auditStart = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log').get() as { id: number }).id;
};
let auditStart = 0;
const newAudit = (): AuditRow[] => db.prepare("SELECT action, target, success, details, user_id FROM audit_log WHERE id > ? AND action LIKE 'pterodactyl.%' ORDER BY id").all(auditStart) as AuditRow[];

async function ensureStepUp(): Promise<void> {
  const res = await elevated.stepUp(admin);
  expect(res.status).toBe(200);
}

async function configure(): Promise<void> {
  await ensureStepUp();
  const res = await elevated.put<SettingsView<{ url: string }>>('/api/settings/pterodactyl', { url: `${panelUrl}/`, applicationKey: APP_KEY, clientKey: CLIENT_KEY });
  expect(res.status).toBe(200);
}

const whmcsRef = (id: number, email: string): WhmcsClientRef => ({ id, name: `Client ${id}`, email, companyName: null, status: 'Active' });

beforeAll(async () => {
  useFakeClock();
  panel.reset();
  fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  panelUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  app = await buildTestApp();
  admin = await createTestAdmin('ptero');
  plain = new Browser(app, uniqueIp());
  elevated = new Browser(app, uniqueIp());
  await plain.login(admin);
  // Une connexion accorde une fenêtre de step-up : on la laisse expirer pour la session « plain ».
  advance(5 * 60_000 + 1_000);
  await elevated.login(admin);
  const session = await plain.get<{ stepUpUntil: string | null }>('/api/auth/session');
  if (session.body.data.stepUpUntil !== null) throw new Error('la session « plain » ne doit pas avoir de step-up');
});

beforeEach(() => {
  panel.reset();
  invalidateCache();
  whmcs.findClientsByEmails.mockReset();
  whmcs.findClientsByEmails.mockResolvedValue(new Map());
  clearAudit();
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
});

// ───────────────────────────── Fonctions pures ─────────────────────────────

describe('normalisation des états', () => {
  const live = (currentState: string, suspended = false) => ({ currentState, suspended });
  it('reprend l’état en direct pour un serveur normal', () => {
    for (const state of ['running', 'starting', 'stopping', 'offline'] as const) {
      expect(normalizeState({ status: null, suspended: false }, live(state))).toBe(state);
    }
    expect(normalizeState({ status: null, suspended: false }, live('quelque-chose'))).toBe('unknown');
    expect(normalizeState({ status: null, suspended: false }, live(''))).toBe('unknown');
  });
  it('la suspension prime sur tout le reste', () => {
    expect(normalizeState({ status: null, suspended: true }, live('running'))).toBe('suspended');
    expect(normalizeState({ status: 'installing', suspended: true }, null)).toBe('suspended');
    expect(normalizeState({ status: null, suspended: false }, live('running', true))).toBe('suspended');
  });
  it('installation, états non exploitables et ressources illisibles', () => {
    expect(normalizeState({ status: 'installing', suspended: false }, live('offline'))).toBe('installing');
    expect(normalizeState({ status: 'install_failed', suspended: false }, live('offline'))).toBe('unknown');
    expect(normalizeState({ status: 'restoring_backup', suspended: false }, null)).toBe('unknown');
    expect(normalizeState({ status: null, suspended: false }, null)).toBe('unknown');
  });
});

describe('Retry-After', () => {
  it('accepte des secondes ou une date HTTP, 1 s par défaut', () => {
    const now = Date.parse('2026-03-01T10:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter('Sun, 01 Mar 2026 10:00:04 GMT', now)).toBe(4000);
    expect(parseRetryAfter('Sun, 01 Mar 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(null, now)).toBe(1000);
    expect(parseRetryAfter('bientôt', now)).toBe(1000);
    expect(parseRetryAfter('-5', now)).toBe(1000);
  });
});

// ───────────────────────────── Non configuré (doit rester AVANT la configuration) ─────────────────────────────

describe('intégration non configurée', () => {
  it('toutes les routes répondent 409 INTEGRATION_NOT_CONFIGURED sans appeler le panel', async () => {
    await ensureStepUp();
    const view = await plain.get<SettingsView<{ url: string }>>('/api/settings/pterodactyl');
    expect(view.body.data).toMatchObject({ configured: false, secrets: { applicationKey: false, clientKey: false } });

    const responses = [
      await plain.get('/api/pterodactyl/servers'),
      await plain.get('/api/pterodactyl/servers/1'),
      await plain.get('/api/pterodactyl/summary'),
      await plain.post('/api/pterodactyl/servers/1/power', { signal: 'start' }),
      await elevated.post('/api/pterodactyl/servers/1/power', { signal: 'stop' }),
      await elevated.post('/api/pterodactyl/servers/1/suspend'),
      await plain.post('/api/pterodactyl/servers/1/unsuspend'),
    ];
    for (const res of responses) {
      expect(res.status).toBe(409);
      expect(res.errorCode).toBe('INTEGRATION_NOT_CONFIGURED');
      expect(res.body.error?.details).toEqual({ integration: 'pterodactyl' });
    }
    expect(panel.requests).toEqual([]);
    // Les tentatives d'action sont journalisées en échec.
    expect(newAudit().map((r) => [r.action, r.target, r.success])).toEqual([
      ['pterodactyl.server.start', 'serveur #1', 0],
      ['pterodactyl.server.stop', 'serveur #1', 0],
      ['pterodactyl.server.suspend', 'serveur #1', 0],
      ['pterodactyl.server.unsuspend', 'serveur #1', 0],
    ]);

    // Le test de connexion est sous step-up ; avec lui, il signale simplement l'absence de configuration.
    const denied = await plain.post('/api/settings/pterodactyl/test');
    expect(denied.status).toBe(403);
    expect(denied.errorCode).toBe('STEP_UP_REQUIRED');
    const test = await elevated.post<SettingsTestResult>('/api/settings/pterodactyl/test');
    expect(test.status).toBe(200);
    expect(test.body.data.ok).toBe(false);
    expect(panel.requests).toEqual([]);
  });

  it('une configuration partielle (une seule clé) reste « non configurée »', async () => {
    await ensureStepUp();
    const res = await elevated.put<SettingsView<{ url: string }>>('/api/settings/pterodactyl', { url: panelUrl, applicationKey: APP_KEY });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ configured: false, secrets: { applicationKey: true, clientKey: false } });
    expect((await plain.get('/api/pterodactyl/servers')).status).toBe(409);
    expect(panel.requests).toEqual([]);
  });
});

// ───────────────────────────── Réglages ─────────────────────────────

describe('réglages', () => {
  it('exige une session, puis un step-up pour écrire', async () => {
    const anonymous = new Browser(app, uniqueIp());
    expect((await anonymous.get('/api/settings/pterodactyl')).status).toBe(401);
    expect((await anonymous.get('/api/pterodactyl/servers')).status).toBe(401);
    expect((await anonymous.get('/api/pterodactyl/summary')).status).toBe(401);
    const res = await plain.put('/api/settings/pterodactyl', { url: panelUrl, applicationKey: APP_KEY, clientKey: CLIENT_KEY });
    expect(res.status).toBe(403);
    expect(res.errorCode).toBe('STEP_UP_REQUIRED');
  });

  it('refuse http hors hôte local, les URL piégées et les clés inversées ou malformées', async () => {
    await ensureStepUp();
    const put = (body: Record<string, unknown>) => elevated.put('/api/settings/pterodactyl', body);
    for (const url of ['http://panel.exemple.com', 'http://192.168.1.10', 'http://127.0.0.1.evil.test', 'ftp://panel.exemple.com', 'https://user:pass@panel.exemple.com', 'https://panel.exemple.com/?x=1', 'pas-une-url', '']) {
      const res = await put({ url });
      expect(res.status, url).toBe(400);
      expect(res.errorCode).toBe('VALIDATION_ERROR');
    }
    const swapped = await put({ url: panelUrl, applicationKey: CLIENT_KEY, clientKey: APP_KEY });
    expect(swapped.status).toBe(400);
    expectNoSecret(swapped.body);
    for (const key of ['court', `${APP_KEY}\r\nX-Injected: 1`, `${APP_KEY} autre`, 'clé-avec-accents-éééééééééééé']) {
      const res = await put({ url: panelUrl, applicationKey: key });
      expect(res.status, key).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(APP_KEY);
    }
  });

  it('enregistre une URL normalisée et ne renvoie jamais les clés', async () => {
    await ensureStepUp();
    const https = await elevated.put<SettingsView<{ url: string }>>('/api/settings/pterodactyl', { url: '  https://Panel.Exemple.com/ptero// ', applicationKey: APP_KEY, clientKey: CLIENT_KEY });
    expect(https.status).toBe(200);
    expect(https.body.data.values).toEqual({ url: 'https://panel.exemple.com/ptero' });

    await configure();
    const view = await plain.get<SettingsView<{ url: string }>>('/api/settings/pterodactyl');
    expect(view.body.data.configured).toBe(true);
    expect(view.body.data.values).toEqual({ url: panelUrl });
    expect(view.body.data.secrets).toEqual({ applicationKey: true, clientKey: true });
    expectNoSecret(view.body);
    // Chiffré en base : la clé n'y figure pas en clair.
    const row = db.prepare("SELECT data_enc FROM integration_settings WHERE namespace = 'pterodactyl'").get() as { data_enc: string };
    expect(row.data_enc).not.toContain(APP_KEY);
    expect(row.data_enc).not.toContain(CLIENT_KEY);
  });

  it('le test vérifie les deux clés séparément et dit laquelle échoue, sans la divulguer', async () => {
    await configure();
    // Sous step-up : le test envoie les clés enregistrées vers l'hôte configuré.
    const denied = await plain.post('/api/settings/pterodactyl/test');
    expect(denied.status).toBe(403);
    expect(denied.errorCode).toBe('STEP_UP_REQUIRED');
    expect(panel.requests).toEqual([]);

    const ok = await elevated.post<SettingsTestResult>('/api/settings/pterodactyl/test');
    expect(ok.body.data).toEqual({ ok: true, message: 'Connexion réussie : clé Application et clé Client valides (5 serveurs)' });
    expect(panel.requests.map((r) => [r.path, r.auth]).sort()).toEqual([
      ['/api/application/servers', `Bearer ${APP_KEY}`],
      ['/api/client/account', `Bearer ${CLIENT_KEY}`],
    ]);

    panel.clientAdmin = false;
    const notAdmin = await elevated.post<SettingsTestResult>('/api/settings/pterodactyl/test');
    expect(notAdmin.body.data.ok).toBe(false);
    expect(notAdmin.body.data.message).toContain('Clé Application : valide');
    expect(notAdmin.body.data.message).toContain("n'est pas administrateur");
    panel.clientAdmin = true;

    // Mauvaise clé Client uniquement.
    await ensureStepUp();
    const wrongClient = 'ptlc_MauvaiseCle0123456789abcdefABCDEF012345678';
    expect((await elevated.put('/api/settings/pterodactyl', { clientKey: wrongClient })).status).toBe(200);
    const badClient = await elevated.post<SettingsTestResult>('/api/settings/pterodactyl/test');
    expect(badClient.body.data.ok).toBe(false);
    expect(badClient.body.data.message).toContain('Clé Application : valide');
    expect(badClient.body.data.message).toContain('Clé Client : échec');
    expect(badClient.body.data.message).not.toContain(wrongClient);
    expectNoSecret(badClient.body);

    // Mauvaise clé Application uniquement.
    const wrongApp = 'ptla_MauvaiseCle0123456789abcdefABCDEF012345678';
    expect((await elevated.put('/api/settings/pterodactyl', { clientKey: CLIENT_KEY, applicationKey: wrongApp })).status).toBe(200);
    const badApp = await elevated.post<SettingsTestResult>('/api/settings/pterodactyl/test');
    expect(badApp.body.data.ok).toBe(false);
    expect(badApp.body.data.message).toContain('Clé Application : échec');
    expect(badApp.body.data.message).toContain('Clé Client : valide');
    expect(badApp.body.data.message).not.toContain(wrongApp);

    await configure();
  });

  it('changer l’URL exige de ressaisir les deux clés dans la même requête', async () => {
    await configure();
    const other = 'https://autre-panel.exemple.com';
    const put = (body: Record<string, unknown>) => elevated.put<SettingsView<{ url: string }>>('/api/settings/pterodactyl', body);
    const required = (res: { body: { error?: { details?: unknown } } }) => [...((res.body.error?.details as { secretsRequired?: string[] } | undefined)?.secretsRequired ?? [])].sort();

    // Sans les clés : refus, et la réponse nomme les secrets à ressaisir.
    const refused = await put({ url: other });
    expect(refused.status).toBe(400);
    expect(refused.errorCode).toBe('VALIDATION_ERROR');
    expect(required(refused)).toEqual(['applicationKey', 'clientKey']);
    expectNoSecret(refused.body);
    // Une seule clé, ou des clés vides (« inchangé ») : refus aussi, seule la clé manquante est réclamée.
    const onlyApplication = await put({ url: other, applicationKey: APP_KEY });
    expect(onlyApplication.status).toBe(400);
    expect(required(onlyApplication)).toEqual(['clientKey']);
    const onlyClient = await put({ url: other, clientKey: CLIENT_KEY });
    expect(onlyClient.status).toBe(400);
    expect(required(onlyClient)).toEqual(['applicationKey']);
    const blanks = await put({ url: other, applicationKey: '', clientKey: '' });
    expect(blanks.status).toBe(400);
    expect(required(blanks)).toEqual(['applicationKey', 'clientKey']);
    for (const res of [onlyApplication, onlyClient, blanks]) expectNoSecret(res.body);

    // Rien n'a été enregistré, aucune requête n'est partie, et chaque refus est journalisé.
    const unchanged = await plain.get<SettingsView<{ url: string }>>('/api/settings/pterodactyl');
    expect(unchanged.body.data.values).toEqual({ url: panelUrl });
    expect(unchanged.body.data.configured).toBe(true);
    expect(panel.requests).toEqual([]);
    const refusals = db
      .prepare("SELECT success, details FROM audit_log WHERE id > ? AND action = 'settings.pterodactyl.update' AND details LIKE '%secrets_required%' ORDER BY id")
      .all(auditStart) as { success: number; details: string }[];
    expect(refusals).toHaveLength(4);
    expect(refusals.every((r) => r.success === 0)).toBe(true);
    expectNoSecret(refusals);
    // La liste est toujours servie par le panel d'origine.
    expect((await plain.get('/api/pterodactyl/servers')).status).toBe(200);

    // La même URL (à la normalisation près) n'est pas un changement : pas de ressaisie exigée.
    expect((await put({ url: `${panelUrl}/` })).status).toBe(200);

    // Avec les deux clés ressaisies dans la même requête : accepté.
    const accepted = await put({ url: other, applicationKey: APP_KEY, clientKey: CLIENT_KEY });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.values).toEqual({ url: other });
    expect(accepted.body.data.secrets).toEqual({ applicationKey: true, clientKey: true });
    expectNoSecret(accepted.body);

    await configure();
  });

  it('modifier les réglages vide le cache', async () => {
    await configure();
    await plain.get('/api/pterodactyl/servers');
    const before = panel.count('GET', /^\/api\/application\/servers$/);
    await plain.get('/api/pterodactyl/servers');
    expect(panel.count('GET', /^\/api\/application\/servers$/)).toBe(before);
    await configure();
    await plain.get('/api/pterodactyl/servers');
    expect(panel.count('GET', /^\/api\/application\/servers$/)).toBeGreaterThan(before);
  });
});

// ───────────────────────────── Lecture ─────────────────────────────

describe('liste des serveurs', () => {
  beforeAll(configure);

  it('suit la pagination, normalise les états et isole une ressource en échec', async () => {
    const res = await plain.get<GameServer[]>('/api/pterodactyl/servers');
    expect(res.status).toBe(200);
    const servers = res.body.data;
    expect(servers.map((s) => s.id)).toEqual([1, 2, 3, 4, 5]);

    // 5 serveurs, 2 par page → 3 pages, avec la clé Application et les inclusions demandées.
    const pages = panel.requests.filter((r) => r.path === '/api/application/servers');
    expect(pages.map((r) => new URLSearchParams(r.query).get('page'))).toEqual(['1', '2', '3']);
    for (const r of pages) {
      expect(new URLSearchParams(r.query).get('include')).toBe('user,node');
      expect(r.auth).toBe(`Bearer ${APP_KEY}`);
      expect(r.accept).toBe('application/json');
    }
    // Ressources : uniquement avec la clé Client, et pas pour les serveurs suspendus ou en installation.
    const resources = panel.requests.filter((r) => r.path.startsWith('/api/client/'));
    expect(resources.map((r) => r.path).sort()).toEqual(['/api/client/servers/aaaa1111/resources', '/api/client/servers/bbbb2222/resources', '/api/client/servers/eeee5555/resources']);
    for (const r of resources) expect(r.auth).toBe(`Bearer ${CLIENT_KEY}`);

    expect(servers.map((s) => s.state)).toEqual(['running', 'offline', 'suspended', 'installing', 'unknown']);
    expect(servers.map((s) => s.suspended)).toEqual([false, false, true, false, false]);

    expect(servers[0]).toEqual({
      id: 1,
      identifier: 'aaaa1111',
      uuid: '00000000-0000-4000-8000-000000000001',
      name: 'Survie',
      description: null,
      node: 'node-paris',
      state: 'running',
      suspended: false,
      resources: { cpuPercent: 12.35, memoryBytes: 512 * 1024 * 1024, diskBytes: 2_000_000_000, uptimeMs: 3_600_000 },
      limits: { cpuPercent: 200, memoryBytes: 2048 * 1024 * 1024, diskBytes: 10240 * 1024 * 1024 },
      owner: { id: 10, username: 'alice', email: 'Alice@Client.test' },
      whmcsClient: null,
      panelUrl: `${panelUrl}/server/aaaa1111`,
    } satisfies GameServer);

    // Ressource en échec (502) : null pour ce serveur seulement.
    expect(servers[4]!.resources).toBeNull();
    expect(servers[2]!.resources).toBeNull();
    expect(servers[3]!.resources).toBeNull();
    expect(servers[1]!.resources).not.toBeNull();
    // Relations absentes (permissions manquantes) : owner et node à null, limites illimitées à 0.
    expect(servers[3]!.owner).toBeNull();
    expect(servers[4]!.node).toBeNull();
    expect(servers[4]!.limits).toEqual({ cpuPercent: 0, memoryBytes: 0, diskBytes: 0 });
    // Données non fiables renvoyées telles quelles, en JSON.
    expect(servers[4]!.name).toBe('<script>alert(1)</script>');
    expect(servers[4]!.description).toBe('<img src=x onerror=alert(1)>');
    expect(res.raw.headers['content-type']).toContain('application/json');

    expectNoSecret(res.body);
    // Seuls les champs du contrat sortent (rien de `container`, `environment`, etc.).
    for (const s of servers) {
      expect(Object.keys(s).sort()).toEqual(['description', 'id', 'identifier', 'limits', 'name', 'node', 'owner', 'panelUrl', 'resources', 'state', 'suspended', 'uuid', 'whmcsClient']);
    }
  });

  it('une coupure réseau ou un état inconnu sur une ressource ne casse pas la liste', async () => {
    panel.servers[0]!.live = 'reset';
    panel.servers[1]!.live = { state: 'starting', cpu: 1, memory: 2, disk: 3, uptime: 4 };
    const res = await plain.get<GameServer[]>('/api/pterodactyl/servers');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ state: 'unknown', resources: null });
    expect(res.body.data[1]).toMatchObject({ state: 'starting', resources: { cpuPercent: 1, memoryBytes: 2, diskBytes: 3, uptimeMs: 4 } });
  });

  it('un serveur signalé suspendu par l’API Client seule est tout de même « suspended »', async () => {
    panel.servers[0]!.live = { state: 'offline', cpu: 0, memory: 0, disk: 0, uptime: 0, isSuspended: true };
    const res = await plain.get<GameServer[]>('/api/pterodactyl/servers');
    expect(res.body.data[0]).toMatchObject({ state: 'suspended', suspended: true });
  });

  it('lie les fiches WHMCS par e-mail du propriétaire, en un seul appel groupé', async () => {
    whmcs.findClientsByEmails.mockResolvedValue(new Map([['alice@client.test', whmcsRef(77, 'alice@client.test')]]));
    const res = await plain.get<GameServer[]>('/api/pterodactyl/servers');
    expect(whmcs.findClientsByEmails).toHaveBeenCalledTimes(1);
    // E-mails dédoublonnés et en minuscules (Alice@Client.test et alice@client.test ne font qu'un).
    expect([...whmcs.findClientsByEmails.mock.calls[0]![0]].sort()).toEqual(['alice@client.test', 'bob@client.test', 'carol@client.test']);
    const byId = new Map(res.body.data.map((s) => [s.id, s]));
    expect(byId.get(1)!.whmcsClient).toEqual(whmcsRef(77, 'alice@client.test'));
    expect(byId.get(3)!.whmcsClient).toEqual(whmcsRef(77, 'alice@client.test'));
    expect(byId.get(2)!.whmcsClient).toBeNull();
    expect(byId.get(4)!.whmcsClient).toBeNull();
  });

  it('WHMCS indisponible (Map vide ou exception) : la liste reste servie sans lien', async () => {
    whmcs.findClientsByEmails.mockRejectedValue(new Error('WHMCS en panne'));
    const res = await plain.get<GameServer[]>('/api/pterodactyl/servers');
    expect(res.status).toBe(200);
    expect(res.body.data.every((s) => s.whmcsClient === null)).toBe(true);
  });

  it('cache court et une seule requête en vol', async () => {
    const [a, b, c] = await Promise.all([plain.get<GameServer[]>('/api/pterodactyl/servers'), plain.get<PterodactylSummary>('/api/pterodactyl/summary'), plain.get<GameServer>('/api/pterodactyl/servers/2')]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(panel.count('GET', /^\/api\/application\/servers$/)).toBe(3);
    expect(panel.count('GET', /\/resources$/)).toBe(3);

    await plain.get('/api/pterodactyl/servers');
    expect(panel.count('GET', /^\/api\/application\/servers$/)).toBe(3);

    advance(16_000);
    await plain.get('/api/pterodactyl/servers');
    expect(panel.count('GET', /^\/api\/application\/servers$/)).toBe(6);
  });

  it('un node en panne n’est pas interrogé pour chacun de ses serveurs', async () => {
    const dead = { id: 7, name: 'node-mort' };
    panel.pageSize = 50;
    panel.servers = Array.from({ length: 30 }, (_, i) => ({
      id: 100 + i,
      identifier: `dead${String(i).padStart(4, '0')}`,
      name: `Serveur ${i}`,
      description: '',
      status: null,
      suspended: false,
      node: dead,
      user: null,
      limits: { memory: 1024, disk: 1024, cpu: 100 },
      live: { fail: 502 } as Live,
    }));
    const res = await plain.get<GameServer[]>('/api/pterodactyl/servers');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(30);
    expect(res.body.data.every((s) => s.state === 'unknown' && s.resources === null)).toBe(true);
    // 8 requêtes en parallèle au plus, puis le node est abandonné après 2 échecs.
    expect(panel.count('GET', /\/resources$/)).toBeLessThanOrEqual(9);
    // Aucun e-mail de propriétaire : WHMCS n'est pas sollicité.
    expect(whmcs.findClientsByEmails).not.toHaveBeenCalled();
  });

  it('ignore un serveur dont l’identifiant renvoyé par le panel n’a pas le format attendu', async () => {
    panel.servers[1]!.identifier = '../../application/users';
    const res = await plain.get<GameServer[]>('/api/pterodactyl/servers');
    expect(res.status).toBe(200);
    expect(res.body.data.map((s) => s.id)).toEqual([1, 3, 4, 5]);
    expect(panel.requests.every((r) => !r.path.includes('users'))).toBe(true);
  });

  it('panel en erreur : 502 UPSTREAM_ERROR sobre, sans secret ni détail distant', async () => {
    // Clé Application refusée.
    await ensureStepUp();
    await elevated.put('/api/settings/pterodactyl', { applicationKey: 'ptla_MauvaiseCle0123456789abcdefABCDEF012345678' });
    const res = await plain.get('/api/pterodactyl/servers');
    expect(res.status).toBe(502);
    expect(res.errorCode).toBe('UPSTREAM_ERROR');
    expect(res.body.error?.message).toBe('Clé Application refusée par Pterodactyl (clé invalide ou permissions insuffisantes)');
    expect(JSON.stringify(res.body)).not.toContain('MauvaiseCle');
    expectNoSecret(res.body);
    const summary = await plain.get('/api/pterodactyl/summary');
    expect(summary.status).toBe(502);
    await configure();
  });

  it('panel injoignable : 502 sans fuite de l’URL', async () => {
    await ensureStepUp();
    // Port 9 (discard) sur la boucle locale : connexion refusée.
    // L'URL change : les clés doivent être ressaisies avec elle.
    expect((await elevated.put('/api/settings/pterodactyl', { url: 'http://127.0.0.1:9', applicationKey: APP_KEY, clientKey: CLIENT_KEY })).status).toBe(200);
    const res = await plain.get('/api/pterodactyl/servers');
    expect(res.status).toBe(502);
    expect(res.errorCode).toBe('UPSTREAM_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('127.0.0.1');
    expectNoSecret(res.body);
    await configure();
  });
});

describe('limite de débit (429)', () => {
  beforeAll(configure);

  it('respecte Retry-After puis réussit', async () => {
    panel.rateLimits = [{ prefix: '/api/application/servers', remaining: 1, retryAfter: '1' }];
    const started = performance.now();
    const res = await plain.get<GameServer[]>('/api/pterodactyl/servers');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(performance.now() - started).toBeGreaterThanOrEqual(950);
    expect(panel.count('GET', /^\/api\/application\/servers$/)).toBe(4);
  });

  it('ne boucle pas : abandon après un nombre borné de tentatives', async () => {
    panel.rateLimits = [{ prefix: '/api/application/servers', remaining: 1000, retryAfter: '0' }];
    const res = await plain.get('/api/pterodactyl/servers');
    expect(res.status).toBe(502);
    expect(res.errorCode).toBe('UPSTREAM_ERROR');
    expect(res.body.error?.message).toBe('Limite de débit de Pterodactyl atteinte, réessayez dans un instant');
    expect(panel.count('GET', /^\/api\/application\/servers$/)).toBe(3);
  });

  it('n’attend pas un Retry-After déraisonnable', async () => {
    panel.rateLimits = [{ prefix: '/api/application/servers', remaining: 1000, retryAfter: '3600' }];
    const started = performance.now();
    const res = await plain.get('/api/pterodactyl/servers');
    expect(res.status).toBe(502);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(panel.count('GET', /^\/api\/application\/servers$/)).toBe(1);
  });

  it('un 429 sur les ressources d’un serveur reste isolé', async () => {
    panel.rateLimits = [{ prefix: '/api/client/servers/aaaa1111/', remaining: 1000, retryAfter: '0' }];
    const res = await plain.get<GameServer[]>('/api/pterodactyl/servers');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ state: 'unknown', resources: null });
    expect(res.body.data[1]).toMatchObject({ state: 'offline' });
    expect(panel.count('GET', /aaaa1111\/resources$/)).toBe(2);
  });
});

describe('détail et résumé', () => {
  beforeAll(configure);

  it('GET /servers/:id renvoie le serveur, 404 s’il est inconnu', async () => {
    const res = await plain.get<GameServer>('/api/pterodactyl/servers/2');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 2, identifier: 'bbbb2222', name: 'Créatif', state: 'offline', panelUrl: `${panelUrl}/server/bbbb2222` });
    expectNoSecret(res.body);
    const missing = await plain.get('/api/pterodactyl/servers/999');
    expect(missing.status).toBe(404);
    expect(missing.errorCode).toBe('NOT_FOUND');
  });

  it('rejette tout :id qui n’est pas un entier positif, sans appeler le panel', async () => {
    await ensureStepUp();
    const bad = ['abc', '1.5', '0', '-1', '1e3', '0x10', '01', '12abc', '1%2Fpower', 'aaaa1111', '99999999999', '2147483648', '%201'];
    for (const id of bad) {
      for (const res of [
        await plain.get(`/api/pterodactyl/servers/${id}`),
        await plain.post(`/api/pterodactyl/servers/${id}/power`, { signal: 'start' }),
        await elevated.post(`/api/pterodactyl/servers/${id}/suspend`),
        await plain.post(`/api/pterodactyl/servers/${id}/unsuspend`),
      ]) {
        expect(res.status, id).toBe(400);
        expect(res.errorCode, id).toBe('VALIDATION_ERROR');
      }
    }
    // « .. » encodé : écarté par le routeur (404) ou par la validation (400), jamais transmis au panel.
    for (const res of [await plain.get('/api/pterodactyl/servers/%2e%2e'), await plain.post('/api/pterodactyl/servers/%2e%2e/power', { signal: 'start' })]) {
      expect([400, 404]).toContain(res.status);
    }
    expect(panel.requests).toEqual([]);
    expect(newAudit()).toEqual([]);
  });

  it('résumé : totaux et serveurs hors ligne non suspendus', async () => {
    // Un serveur suspendu que Wings dirait « offline » ne compte pas comme hors ligne.
    const res = await plain.get<PterodactylSummary>('/api/pterodactyl/summary');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ total: 5, running: 1, offline: 1, suspended: 1, offlineServers: [{ id: 2, name: 'Créatif', node: 'node-paris' }] });
    expectNoSecret(res.body);
  });

  it('le résumé ne prolonge pas la session (route d’arrière-plan)', async () => {
    const lastSeen = () => (db.prepare('SELECT MAX(last_seen_at) AS t FROM sessions WHERE user_id = ?').get(admin.user.id) as { t: number }).t;
    await plain.get('/api/pterodactyl/servers');
    const before = lastSeen();
    advance(5_000);
    await plain.get('/api/pterodactyl/summary');
    expect(lastSeen()).toBe(before);
  });
});

// ───────────────────────────── Actions ─────────────────────────────

describe('alimentation', () => {
  beforeAll(configure);

  it('start passe sans step-up, restart avec ; l’identifiant vient de l’API Application', async () => {
    await ensureStepUp();
    // Seul « start » est dispensé de step-up : il part d'une session sans re-confirmation.
    const cases = [
      { browser: plain, signal: 'start' },
      { browser: elevated, signal: 'restart' },
    ] as const;
    for (const { browser, signal } of cases) {
      panel.requests = [];
      const res = await browser.post('/api/pterodactyl/servers/2/power', { signal });
      expect(res.status, signal).toBe(200);
      expect(res.body.data).toEqual({ ok: true });
      expect(panel.requests.map((r) => [r.method, r.path, r.auth])).toEqual([
        ['GET', '/api/application/servers/2', `Bearer ${APP_KEY}`],
        ['POST', '/api/client/servers/bbbb2222/power', `Bearer ${CLIENT_KEY}`],
      ]);
      expect(JSON.parse(panel.requests[1]!.body)).toEqual({ signal });
    }
    const rows = newAudit();
    expect(rows.map((r) => [r.action, r.target, r.success, r.user_id])).toEqual([
      ['pterodactyl.server.start', 'serveur #2 (Créatif)', 1, admin.user.id],
      ['pterodactyl.server.restart', 'serveur #2 (Créatif)', 1, admin.user.id],
    ]);
    expect(JSON.parse(rows[0]!.details!)).toEqual({ signal: 'start', serverId: 2 });
    expectNoSecret(rows);
  });

  it('restart, stop et kill exigent un step-up : sans lui, 403 et aucun appel distant', async () => {
    for (const signal of ['restart', 'stop', 'kill'] as const) {
      const res = await plain.post('/api/pterodactyl/servers/1/power', { signal });
      expect(res.status, signal).toBe(403);
      expect(res.errorCode).toBe('STEP_UP_REQUIRED');
    }
    expect(panel.requests).toEqual([]);
    expect(newAudit()).toEqual([]);

    await ensureStepUp();
    for (const signal of ['restart', 'stop', 'kill'] as const) {
      const res = await elevated.post('/api/pterodactyl/servers/1/power', { signal });
      expect(res.status, signal).toBe(200);
    }
    expect(panel.requests.filter((r) => r.method === 'POST').map((r) => [r.path, JSON.parse(r.body)])).toEqual([
      ['/api/client/servers/aaaa1111/power', { signal: 'restart' }],
      ['/api/client/servers/aaaa1111/power', { signal: 'stop' }],
      ['/api/client/servers/aaaa1111/power', { signal: 'kill' }],
    ]);
    expect(newAudit().map((r) => [r.action, r.target, r.success])).toEqual([
      ['pterodactyl.server.restart', 'serveur #1 (Survie)', 1],
      ['pterodactyl.server.stop', 'serveur #1 (Survie)', 1],
      ['pterodactyl.server.kill', 'serveur #1 (Survie)', 1],
    ]);
  });

  it('le corps est validé avant le step-up et avant tout appel distant', async () => {
    const bodies: Record<string, unknown>[] = [{}, { signal: 'reboot' }, { signal: 'STOP' }, { signal: ['start'] }, { signal: 'start', identifier: 'aaaa1111' }, { signal: 'start', extra: 1 }];
    for (const body of bodies) {
      const res = await plain.post('/api/pterodactyl/servers/1/power', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.errorCode).toBe('VALIDATION_ERROR');
    }
    expect(panel.requests).toEqual([]);
  });

  it('exige session et CSRF comme toute route /api', async () => {
    const anonymous = new Browser(app, uniqueIp());
    expect((await anonymous.post('/api/pterodactyl/servers/1/power', { signal: 'start' })).status).toBe(401);
    const noCsrf = await plain.post('/api/pterodactyl/servers/1/power', { signal: 'start' }, { csrf: null });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.errorCode).toBe('CSRF_INVALID');
    const badOrigin = await plain.post('/api/pterodactyl/servers/1/unsuspend', {}, { origin: 'https://evil.test' });
    expect(badOrigin.status).toBe(403);
    expect(panel.requests).toEqual([]);
  });

  it('serveur inconnu : 404, journalisé en échec, aucun signal envoyé', async () => {
    const res = await plain.post('/api/pterodactyl/servers/999/power', { signal: 'start' });
    expect(res.status).toBe(404);
    expect(res.errorCode).toBe('NOT_FOUND');
    expect(panel.count('POST', /power$/)).toBe(0);
    const rows = newAudit();
    expect(rows.map((r) => [r.action, r.target, r.success])).toEqual([['pterodactyl.server.start', 'serveur #999', 0]]);
    expect(JSON.parse(rows[0]!.details!)).toMatchObject({ signal: 'start', serverId: 999, error: { code: 'NOT_FOUND' } });
  });

  it('échec distant : 502 sobre, journalisé en échec, sans secret ni corps distant', async () => {
    await ensureStepUp();
    panel.failActions = 500;
    const res = await elevated.post('/api/pterodactyl/servers/1/power', { signal: 'restart' });
    expect(res.status).toBe(502);
    expect(res.errorCode).toBe('UPSTREAM_ERROR');
    expect(res.body.error?.message).toBe('Pterodactyl a répondu avec le statut 500');
    expectNoSecret(res.body);
    expect(JSON.stringify(res.body)).not.toContain('détail interne');

    panel.failActions = 409;
    const conflict = await plain.post('/api/pterodactyl/servers/3/power', { signal: 'start' });
    expect(conflict.status).toBe(502);
    expect(conflict.body.error?.message).toContain('suspendu');

    const rows = newAudit();
    expect(rows.map((r) => [r.action, r.target, r.success])).toEqual([
      ['pterodactyl.server.restart', 'serveur #1 (Survie)', 0],
      ['pterodactyl.server.start', 'serveur #3 (Suspendu)', 0],
    ]);
    expectNoSecret(rows);
    expect(JSON.stringify(rows)).not.toContain('détail interne');
  });

  it('une action invalide le cache', async () => {
    await plain.get('/api/pterodactyl/servers');
    const before = panel.count('GET', /^\/api\/application\/servers$/);
    panel.servers[1]!.live = running(50);
    await plain.post('/api/pterodactyl/servers/2/power', { signal: 'start' });
    const res = await plain.get<GameServer>('/api/pterodactyl/servers/2');
    expect(res.body.data.state).toBe('running');
    expect(panel.count('GET', /^\/api\/application\/servers$/)).toBe(before + 3);
  });

  it('le nom du serveur, non fiable, est journalisé tel quel et tronqué', async () => {
    panel.servers[0]!.name = `<b>${'x'.repeat(500)}`;
    await plain.post('/api/pterodactyl/servers/1/power', { signal: 'start' });
    const row = newAudit()[0]!;
    expect(row.target!.startsWith('serveur #1 (<b>xxx')).toBe(true);
    expect(row.target!.length).toBeLessThan(140);
  });
});

describe('suspension', () => {
  beforeAll(configure);

  it('suspendre exige un step-up ; réactiver non', async () => {
    const denied = await plain.post('/api/pterodactyl/servers/1/suspend');
    expect(denied.status).toBe(403);
    expect(denied.errorCode).toBe('STEP_UP_REQUIRED');
    expect(panel.requests).toEqual([]);
    expect(panel.servers[0]!.suspended).toBe(false);

    await ensureStepUp();
    const res = await elevated.post('/api/pterodactyl/servers/1/suspend');
    expect(res.status).toBe(200);
    expect(panel.servers[0]!.suspended).toBe(true);
    expect(panel.requests.map((r) => [r.method, r.path, r.auth])).toEqual([
      ['GET', '/api/application/servers/1', `Bearer ${APP_KEY}`],
      ['POST', '/api/application/servers/1/suspend', `Bearer ${APP_KEY}`],
    ]);
    // Cache invalidé : la liste reflète aussitôt la suspension.
    const list = await plain.get<GameServer[]>('/api/pterodactyl/servers');
    expect(list.body.data[0]).toMatchObject({ id: 1, state: 'suspended', suspended: true, resources: null });

    const back = await plain.post('/api/pterodactyl/servers/1/unsuspend');
    expect(back.status).toBe(200);
    expect(panel.servers[0]!.suspended).toBe(false);
    expect(panel.count('POST', /^\/api\/application\/servers\/1\/unsuspend$/)).toBe(1);

    expect(newAudit().map((r) => [r.action, r.target, r.success, r.user_id])).toEqual([
      ['pterodactyl.server.suspend', 'serveur #1 (Survie)', 1, admin.user.id],
      ['pterodactyl.server.unsuspend', 'serveur #1 (Survie)', 1, admin.user.id],
    ]);
  });

  it('échec de suspension : 502 et entrée de journal en échec', async () => {
    await ensureStepUp();
    panel.failActions = 403;
    const res = await elevated.post('/api/pterodactyl/servers/2/suspend');
    expect(res.status).toBe(502);
    expect(res.body.error?.message).toBe('Clé Application refusée par Pterodactyl (clé invalide ou permissions insuffisantes)');
    expectNoSecret(res.body);
    expect(panel.servers[1]!.suspended).toBe(false);
    expect(newAudit().map((r) => [r.action, r.target, r.success])).toEqual([['pterodactyl.server.suspend', 'serveur #2 (Créatif)', 0]]);
  });
});

describe('journal', () => {
  it('aucune entrée du module ne contient de secret', () => {
    const rows = auditRows();
    expect(rows.length).toBeGreaterThan(10);
    expectNoSecret(rows);
    const settings = db.prepare("SELECT details FROM audit_log WHERE action LIKE 'settings.pterodactyl.%'").all();
    expectNoSecret(settings);
  });
});
