import { createServer, type Server } from 'node:https';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import type {
  GuestActionResult,
  ProxmoxGuest,
  ProxmoxNode,
  ProxmoxNodeHistoryPoint,
  ProxmoxSettingsValues,
  ProxmoxSummary,
  SettingsTestResult,
  SettingsView,
} from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSettings } from '../src/core/settings.js';
import { db } from '../src/db/index.js';
import { isNodeName, isVmid } from '../src/modules/proxmox/normalize.js';
import { advance, Browser, buildTestApp, createTestAdmin, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

/**
 * Aucun Proxmox réel : un faux serveur HTTPS local (certificat auto-signé de test, valable pour 127.0.0.1)
 * joue l'API. Le client du module est donc exercé de bout en bout, TLS compris.
 */

// Paire de test générée pour ce fichier uniquement (aucune valeur en dehors des tests).
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg1BMDuZXDmB6ygvsc
JWlqoJsc0rU8LPbK1Lb6ylNVntahRANCAASKJek/7x89EWrLfUSlU1w082nboxJ1
50RxVMBNwxN9S0bfsatjNKz8VC2mbHQ24t+frZOfB/1Y98OBAmveH/Vb
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBqTCCAU+gAwIBAgIUeZ2bp9uw0UjyoNPhyl1HH4evmbAwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQcHZlLXRlc3QuaW52YWxpZDAgFw0yNjEwMTMxOTA3MTZaGA8y
MTI2MDkxOTE5MDcxNlowGzEZMBcGA1UEAwwQcHZlLXRlc3QuaW52YWxpZDBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABIol6T/vHz0Rast9RKVTXDTzadujEnXnRHFU
wE3DE31LRt+xq2M0rPxULaZsdDbi35+tk58H/Vj3w4ECa94f9VujbzBtMB0GA1Ud
DgQWBBSJ0EmhiSO+rZrzcZudXsYPofRGUjAfBgNVHSMEGDAWgBSJ0EmhiSO+rZrz
cZudXsYPofRGUjAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGHBH8AAAGCCWxv
Y2FsaG9zdDAKBggqhkjOPQQDAgNIADBFAiEAyKxIbdUnuZLlzayZmpl1wJ8Hfapr
inbjf0F+kTRXOo4CIBRyDxHx0/LN2jN9uChKSBhEIJF2QRoRw3BvUa7PKYpZ
-----END CERTIFICATE-----
`;
/** Clé de OTHER_CA (certificat sans aucun nom alternatif : il ne couvre donc pas 127.0.0.1). */
const OTHER_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgrkZI4eUiydwro76k
vEeGeb8otkQbk+0urjJJlgJtLEmhRANCAAQfZ5tvJZcwLfolRvpV7M6DTiNVJCa3
/o43QMStaoCToGl5sj9/vL7dSSCqx+WHLh2YPLFPzSWw+TkS1HxrVIRd
-----END PRIVATE KEY-----
`;
/** Autre autorité, sans rapport avec le serveur de test. */
const OTHER_CA = `-----BEGIN CERTIFICATE-----
MIIBjDCCATOgAwIBAgIUAeoNExzr9adRNcv3f50+//T+KdcwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQYXV0cmUtY2EuaW52YWxpZDAgFw0yNjEwMTMxOTA3MTZaGA8y
MTI2MDkxOTE5MDcxNlowGzEZMBcGA1UEAwwQYXV0cmUtY2EuaW52YWxpZDBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABB9nm28llzAt+iVG+lXszoNOI1UkJrf+jjdA
xK1qgJOgaXmyP3+8vt1JIKrH5YcuHZg8sU/NJbD5ORLUfGtUhF2jUzBRMB0GA1Ud
DgQWBBRYQsHD5w0h1COUwTft9WxIiUlODzAfBgNVHSMEGDAWgBRYQsHD5w0h1COU
wTft9WxIiUlODzAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIAL5
M6WXHDGnZJLwZaKl7Lrb8zfLW57EfHoL63uo41OpAiBa+KGgRL+SS+V0Bh5UDjpd
f7gvYoyskRwjV9VKturhdA==
-----END CERTIFICATE-----
`;

const TOKEN_ID = 'panel@pve!talcloud';
const TOKEN_SECRET = '3f9c1a52-7b0e-4d6a-9c11-5e2f8a7b4c90';
/** Marqueur placé dans tous les corps d'erreur du faux Proxmox : il ne doit jamais atteindre le client. */
const RAW_MARKER = 'CORPS-BRUT-PROXMOX';
const XSS_NAME = '<img src=x onerror=alert(1)>';
const GIB = 1024 ** 3;

// ── Faux Proxmox ──

interface Call {
  method: string;
  path: string; // chemin brut, tel que reçu (encodage compris)
  query: string;
  authorization: string | undefined;
  contentLength: string | undefined;
}

const pve = {
  calls: [] as Call[],
  /** Réponses forcées, par « MÉTHODE chemin ». */
  forced: new Map<string, { status: number; body?: unknown }>(),
  resources: [] as Record<string, unknown>[],
  permissions: {} as Record<string, Record<string, number>>,
  rrd: [] as Record<string, unknown>[],
  delayMs: 0,
};

const baseResources = (): Record<string, unknown>[] => [
  { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online', cpu: 0.2512, maxcpu: 16, mem: 8 * GIB, maxmem: 32 * GIB, disk: 20 * GIB, maxdisk: 100 * GIB, uptime: 86_400 },
  { id: 'node/pve2', type: 'node', node: 'pve2', status: 'offline', maxcpu: 8, maxmem: 16 * GIB, maxdisk: 50 * GIB },
  { id: 'node/pve3', type: 'node', node: 'pve3', status: 'online', cpu: 0.1, maxcpu: 4, mem: 2 * GIB, maxmem: 8 * GIB, disk: 5 * GIB, maxdisk: 40 * GIB, uptime: 120 },
  { id: 'storage/pve1/local', type: 'storage', node: 'pve1', storage: 'local', status: 'available' },
  { id: 'qemu/100', type: 'qemu', vmid: 100, node: 'pve1', name: 'web01', status: 'running', template: 0, cpu: 0.5, maxcpu: 4, mem: 2 * GIB, maxmem: 4 * GIB, disk: 0, maxdisk: 32 * GIB, uptime: 3600, tags: 'prod;web' },
  { id: 'qemu/101', type: 'qemu', vmid: 101, node: 'pve1', name: 'debian-12-modele', status: 'stopped', template: 1, cpu: 0, maxcpu: 2, mem: 0, maxmem: 2 * GIB, disk: 0, maxdisk: 8 * GIB, uptime: 0 },
  { id: 'lxc/200', type: 'lxc', vmid: 200, node: 'pve1', name: 'ct-db', status: 'stopped', template: 0, cpu: 0, maxcpu: 2, mem: 0, maxmem: 1 * GIB, disk: 3 * GIB, maxdisk: 10 * GIB, uptime: 0, tags: 'db, interne' },
  { id: 'qemu/300', type: 'qemu', vmid: 300, node: 'pve3', name: XSS_NAME, status: 'paused', template: 0, cpu: 1.7, maxcpu: 2, mem: '1073741824', maxmem: 2 * GIB, disk: 0, maxdisk: 16 * GIB, uptime: 50 },
  { id: 'lxc/301', type: 'lxc', vmid: 301, node: 'pve2', status: 'unknown', maxcpu: 1, maxmem: 512 * 1024 ** 2, maxdisk: 4 * GIB },
  // Entrées invalides : elles doivent être ignorées, jamais relayées.
  { id: 'qemu/5', type: 'qemu', vmid: 5, node: 'pve1', name: 'vmid-trop-petit', status: 'running' },
  { id: 'qemu/400', type: 'qemu', vmid: 400, node: '../evil', name: 'node-piege', status: 'running' },
  { id: 'qemu/x', type: 'qemu', vmid: 'abc', node: 'pve1', name: 'vmid-texte', status: 'running' },
];

let server: Server;
let pveUrl: string;

function startFakePve(): Promise<void> {
  server = createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://pve.invalid');
    const rawPath = (req.url ?? '/').split('?')[0]!;
    pve.calls.push({ method: req.method ?? '', path: rawPath, query: url.search, authorization: req.headers.authorization, contentLength: req.headers['content-length'] });
    const send = (status: number, body: unknown) => {
      const done = () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (pve.delayMs) setTimeout(done, pve.delayMs);
      else done();
    };
    const error = (status: number) => send(status, { data: null, message: `${RAW_MARKER} statut ${status}` });
    req.resume();

    if (req.headers.authorization !== `PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}`) return error(401);
    const forced = pve.forced.get(`${req.method} ${rawPath}`);
    if (forced) return forced.body === undefined ? error(forced.status) : send(forced.status, forced.body);

    const path = rawPath.replace(/^\/api2\/json/, '');
    if (req.method === 'GET' && path === '/version') return send(200, { data: { version: '8.2.4', release: '8.2', repoid: 'faa83925' } });
    if (req.method === 'GET' && path === '/access/permissions') return send(200, { data: pve.permissions });
    if (req.method === 'GET' && path === '/cluster/resources') {
      const type = url.searchParams.get('type');
      const wanted = type === 'vm' ? ['qemu', 'lxc'] : type ? [type] : null;
      return send(200, { data: pve.resources.filter((r) => !wanted || wanted.includes(String(r.type))) });
    }
    const status = /^\/nodes\/([^/]+)\/status$/.exec(path);
    if (req.method === 'GET' && status) {
      if (status[1] === 'pve1') return send(200, { data: { loadavg: ['0.52', '0.48', '0.40'], pveversion: 'pve-manager/8.2.4/faa83925c9641325', uptime: 86_400 } });
      return error(595);
    }
    const rrd = /^\/nodes\/([^/]+)\/rrddata$/.exec(path);
    if (req.method === 'GET' && rrd) return send(200, { data: pve.rrd });
    const action = /^\/nodes\/([^/]+)\/(qemu|lxc)\/(\d+)\/status\/(start|shutdown|stop|reboot)$/.exec(path);
    if (req.method === 'POST' && action) return send(200, { data: `UPID:${action[1]}:0001E240:0A1B2C3D:65F0A1B2:${action[2] === 'qemu' ? 'qm' : 'vz'}${action[4]}:${action[3]}:${TOKEN_ID}:` });
    return error(501);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      pveUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

// ── Outils ──

let app: FastifyInstance;
let admin: TestAdmin;

/** Nouvelle session (la connexion ouvre une fenêtre de step-up de 5 minutes). */
async function session(): Promise<Browser> {
  const browser = new Browser(app, uniqueIp());
  await browser.login(admin);
  return browser;
}

/** Session dont la fenêtre de step-up est expirée. */
async function sessionWithoutStepUp(): Promise<Browser> {
  const browser = await session();
  advance(5 * 60_000 + 1_000);
  return browser;
}

async function configure(overrides: Record<string, unknown> = {}) {
  const browser = await session();
  const res = await browser.put<SettingsView<ProxmoxSettingsValues>>('/api/settings/proxmox', {
    url: pveUrl,
    tokenId: TOKEN_ID,
    tokenSecret: TOKEN_SECRET,
    verifyTls: true,
    caCert: TEST_CERT,
    ...overrides,
  });
  return { browser, res };
}

interface AuditRow {
  action: string;
  target: string | null;
  success: number;
  details: string | null;
}
const proxmoxAudit = (): AuditRow[] => db.prepare("SELECT action, target, success, details FROM audit_log WHERE action LIKE 'proxmox.%' ORDER BY id").all() as AuditRow[];
const lastAudit = (): AuditRow & { parsed: Record<string, unknown> } => {
  const row = proxmoxAudit().at(-1)!;
  return { ...row, parsed: row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {} };
};
const posts = (): Call[] => pve.calls.filter((c) => c.method === 'POST');
const actionUrl = (node: string, type: string, vmid: string | number) => `/api/proxmox/guests/${node}/${type}/${vmid}/action`;

beforeAll(async () => {
  useFakeClock();
  await startFakePve();
  app = await buildTestApp();
  admin = await createTestAdmin('alice');
});

beforeEach(() => {
  // Vide les fenêtres de limitation de débit et fait expirer le cache du module (10 s).
  advance(61_000);
  pve.calls.length = 0;
  pve.forced.clear();
  pve.resources = baseResources();
  pve.permissions = { '/': { 'Sys.Audit': 1, 'VM.Audit': 1, 'VM.PowerMgmt': 1 } };
  pve.rrd = [];
  pve.delayMs = 0;
});

afterAll(async () => {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
});

// ── Tests ──

describe('proxmox — accès et intégration non configurée', () => {
  it('toutes les routes exigent une session, et un jeton CSRF pour l’action', async () => {
    const anonymous = new Browser(app, uniqueIp());
    for (const url of ['/api/proxmox/nodes', '/api/proxmox/guests', '/api/proxmox/summary', '/api/proxmox/nodes/pve1/history', '/api/settings/proxmox']) {
      expect((await anonymous.get(url)).status).toBe(401);
    }
    expect((await anonymous.post(actionUrl('pve1', 'qemu', 100), { action: 'start' })).status).toBe(401);

    const browser = await session();
    const noCsrf = await browser.post(actionUrl('pve1', 'qemu', 100), { action: 'start' }, { csrf: null });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.errorCode).toBe('CSRF_INVALID');
    expect(pve.calls).toEqual([]);
  });

  it('409 INTEGRATION_NOT_CONFIGURED tant que les réglages sont absents', async () => {
    const browser = await session();
    for (const url of ['/api/proxmox/nodes', '/api/proxmox/guests', '/api/proxmox/summary', '/api/proxmox/nodes/pve1/history']) {
      const res = await browser.get(url);
      expect(res.status).toBe(409);
      expect(res.errorCode).toBe('INTEGRATION_NOT_CONFIGURED');
      expect(res.body.error?.details).toEqual({ integration: 'proxmox' });
    }
    const action = await browser.post(actionUrl('pve1', 'qemu', 100), { action: 'start' });
    expect(action.status).toBe(409);
    expect(lastAudit()).toMatchObject({ action: 'proxmox.guest.start', target: 'VM 100 @ pve1', success: 0 });

    const test = await browser.post<SettingsTestResult>('/api/settings/proxmox/test');
    expect(test.body.data).toEqual({ ok: false, message: 'Intégration non configurée' });
    const view = await browser.get<SettingsView<ProxmoxSettingsValues>>('/api/settings/proxmox');
    expect(view.body.data).toMatchObject({ configured: false, secrets: { tokenSecret: false } });
    expect(pve.calls).toEqual([]);
  });
});

describe('proxmox — réglages', () => {
  it('l’enregistrement exige un step-up', async () => {
    const browser = await sessionWithoutStepUp();
    const res = await browser.put('/api/settings/proxmox', { url: pveUrl, tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET, verifyTls: true });
    expect(res.status).toBe(403);
    expect(res.errorCode).toBe('STEP_UP_REQUIRED');
    expect(getSettings('proxmox')).toBeNull();
  });

  it('valide le format du tokenId (utilisateur@royaume!nom)', async () => {
    const browser = await session();
    const invalid = ['panel', 'panel@pve', 'panel!talcloud', '@pve!talcloud', 'panel@pve!', 'panel@pve!tal cloud', 'panel@pve!talcloud=abc', 'panel@pve!tal\r\nX-Injecte: 1', 'pa nel@pve!talcloud', 'panel@1pve!talcloud'];
    for (const tokenId of invalid) {
      const res = await browser.put('/api/settings/proxmox', { url: pveUrl, tokenId, tokenSecret: TOKEN_SECRET, verifyTls: true });
      expect(res.status, tokenId).toBe(400);
      expect(res.errorCode).toBe('VALIDATION_ERROR');
    }
    expect(getSettings('proxmox')).toBeNull();
    for (const tokenId of ['root@pam!panel', 'jean.dupont@exemple.fr@ldap-ad!talcloud_1', 'panel@pve!talcloud']) {
      const res = await browser.put('/api/settings/proxmox', { url: pveUrl, tokenId, tokenSecret: TOKEN_SECRET, verifyTls: true });
      expect(res.status, tokenId).toBe(200);
    }
  });

  it('refuse une URL non https, avec identifiants, un secret ou un certificat mal formés', async () => {
    const browser = await session();
    const base = { url: pveUrl, tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET, verifyTls: true };
    const invalid: Record<string, unknown>[] = [
      { ...base, url: 'http://pve.exemple.com:8006' },
      { ...base, url: 'https://root:motdepasse@pve.exemple.com:8006' },
      { ...base, url: 'https://pve.exemple.com:8006/?x=1' },
      { ...base, url: 'file:///etc/passwd' },
      { ...base, url: 'pas une url' },
      { ...base, tokenSecret: 'secret avec espace' },
      { ...base, tokenSecret: 'abc\r\nX-Injecte: 1' },
      { ...base, verifyTls: 'non' },
      { ...base, caCert: 'ceci n’est pas un certificat' },
      { ...base, caCert: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----' },
      // Une clé privée n'a rien à faire dans ce champ.
      { ...base, caCert: `${TEST_CERT}${TEST_KEY}` },
    ];
    for (const body of invalid) {
      const res = await browser.put('/api/settings/proxmox', body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(TOKEN_SECRET);
    }
  });

  it('normalise l’URL, applique verifyTls par défaut et ne renvoie jamais le secret', async () => {
    const browser = await session();
    const put = await browser.put<SettingsView<ProxmoxSettingsValues>>('/api/settings/proxmox', {
      url: `  ${pveUrl}/api2/json/  `,
      tokenId: TOKEN_ID,
      tokenSecret: TOKEN_SECRET,
      caCert: TEST_CERT,
    });
    expect(put.status).toBe(200);
    expect(put.body.data.configured).toBe(true);
    expect(put.body.data.values).toEqual({ url: pveUrl, tokenId: TOKEN_ID, verifyTls: true, caCert: TEST_CERT });
    expect(put.body.data.secrets).toEqual({ tokenSecret: true });
    expect(JSON.stringify(put.body)).not.toContain(TOKEN_SECRET);

    const get = await browser.get<SettingsView<ProxmoxSettingsValues>>('/api/settings/proxmox');
    expect(get.body.data.secrets).toEqual({ tokenSecret: true });
    expect(get.raw.payload).not.toContain(TOKEN_SECRET);
    expect(get.raw.payload).not.toContain('tokenSecret":"');

    // Le secret n'apparaît pas non plus dans le journal, et il est chiffré en base.
    const logged = db.prepare("SELECT details FROM audit_log WHERE action LIKE 'settings.proxmox.%'").all() as { details: string | null }[];
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(TOKEN_SECRET);
    const row = db.prepare("SELECT data_enc FROM integration_settings WHERE namespace = 'proxmox'").get() as { data_enc: string };
    expect(row.data_enc).not.toContain(TOKEN_SECRET);

    // Secret non resaisi = inchangé, tant que la destination (url, verifyTls, caCert) ne change pas.
    const partial = await browser.put<SettingsView<ProxmoxSettingsValues>>('/api/settings/proxmox', { tokenSecret: '', tokenId: 'root@pam!panel' });
    expect(partial.status).toBe(200);
    expect(partial.body.data.values).toEqual({ url: pveUrl, tokenId: 'root@pam!panel', verifyTls: true, caCert: TEST_CERT });
    expect(partial.body.data.secrets).toEqual({ tokenSecret: true });
    expect(getSettings<{ tokenSecret: string }>('proxmox')!.tokenSecret).toBe(TOKEN_SECRET);

    // Certificat vidé = supprimé (changement de destination : le secret est ressaisi).
    const cleared = await browser.put<SettingsView<ProxmoxSettingsValues>>('/api/settings/proxmox', { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET, caCert: '', verifyTls: false });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.values).toEqual({ url: pveUrl, tokenId: TOKEN_ID, verifyTls: false });
    expect(cleared.body.data.secrets).toEqual({ tokenSecret: true });
    expect(JSON.stringify(cleared.body)).not.toContain(TOKEN_SECRET);
  });

  it('changer la destination (url, verifyTls, caCert) exige de ressaisir le secret du jeton', async () => {
    const { browser, res } = await configure();
    expect(res.status).toBe(200);
    const stored = () => getSettings<Record<string, unknown>>('proxmox');
    const before = stored();
    pve.calls.length = 0;

    // Rediriger l'intégration (ou affaiblir son TLS) sans connaître le secret : refusé, rien n'est enregistré.
    const moves: Record<string, unknown>[] = [
      { url: 'https://attaquant.exemple.com:8006' },
      { verifyTls: false },
      { caCert: OTHER_CA },
      { caCert: '' },
      { caCert: null },
      { url: 'https://attaquant.exemple.com:8006', tokenSecret: '' },
      { url: 'https://attaquant.exemple.com:8006', verifyTls: false, caCert: '' },
    ];
    for (const body of moves) {
      const refused = await browser.put('/api/settings/proxmox', body);
      expect(refused.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(refused.errorCode).toBe('VALIDATION_ERROR');
      expect(refused.body.error!.details).toEqual({ secretsRequired: ['tokenSecret'] });
      expect(refused.raw.payload).not.toContain(TOKEN_SECRET);
      expect(stored()).toEqual(before);
    }
    const refusal = db.prepare("SELECT success, details FROM audit_log WHERE action = 'settings.proxmox.update' ORDER BY id DESC LIMIT 1").get() as { success: number; details: string };
    expect(refusal.success).toBe(0);
    expect(JSON.parse(refusal.details)).toMatchObject({ reason: 'secrets_required' });
    // Le jeton enregistré n'est parti nulle part, et l'ancienne destination sert toujours.
    expect(pve.calls).toEqual([]);
    expect((await browser.get('/api/proxmox/guests')).status).toBe(200);

    // Une valeur de destination identique à celle enregistrée n'est pas un changement.
    expect((await browser.put('/api/settings/proxmox', { url: `${pveUrl}/`, verifyTls: true, caCert: TEST_CERT })).status).toBe(200);

    // Avec le secret ressaisi dans la même requête : accepté.
    const accepted = await browser.put<SettingsView<ProxmoxSettingsValues>>('/api/settings/proxmox', { verifyTls: false, caCert: '', tokenSecret: TOKEN_SECRET });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.values).toEqual({ url: pveUrl, tokenId: TOKEN_ID, verifyTls: false });
    expect(accepted.body.data.secrets).toEqual({ tokenSecret: true });
    expect(accepted.raw.payload).not.toContain(TOKEN_SECRET);

    // Le changement de destination exige aussi le step-up, même avec le secret.
    const stale = await sessionWithoutStepUp();
    const noStepUp = await stale.put('/api/settings/proxmox', { verifyTls: true, caCert: TEST_CERT, tokenSecret: TOKEN_SECRET });
    expect(noStepUp.errorCode).toBe('STEP_UP_REQUIRED');
    expect(stored()).toMatchObject({ verifyTls: false });
  });
});

describe('proxmox — TLS et test de connexion', () => {
  const runTest = async (overrides: Record<string, unknown>) => {
    const { browser, res } = await configure(overrides);
    expect(res.status).toBe(200);
    pve.calls.length = 0;
    const test = await browser.post<SettingsTestResult>('/api/settings/proxmox/test');
    expect(test.status).toBe(200);
    expect(test.raw.payload).not.toContain(TOKEN_SECRET);
    expect(test.raw.payload).not.toContain(RAW_MARKER);
    return test.body.data;
  };

  it('certificat auto-signé sans CA fournie : refusé, message TLS, aucune requête ne parvient au serveur', async () => {
    const result = await runTest({ caCert: '' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Certificat TLS de Proxmox refusé/);
    expect(pve.calls).toEqual([]);
  });

  it('CA fournie mais étrangère au serveur : refusé (la vérification reste active)', async () => {
    const result = await runTest({ caCert: OTHER_CA });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Certificat TLS de Proxmox refusé/);
    expect(pve.calls).toEqual([]);
  });

  it('CA correcte : connexion vérifiée, jeton envoyé dans Authorization, sans avertissement', async () => {
    const result = await runTest({});
    expect(result).toEqual({ ok: true, message: 'Connexion réussie (Proxmox VE 8.2.4).' });
    expect(pve.calls[0]).toMatchObject({ method: 'GET', path: '/api2/json/version', authorization: `PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}` });
  });

  it('verifyTls désactivé : accepté, mais le risque est signalé', async () => {
    const result = await runTest({ verifyTls: false, caCert: '' });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Connexion réussie \(Proxmox VE 8\.2\.4\)/);
    expect(result.message).toMatch(/vérification du certificat TLS est désactivée/);
  });

  it('le nom d’hôte doit correspondre au certificat même avec la bonne CA', async () => {
    // Second serveur dont le certificat (de confiance, car fourni comme CA) ne couvre pas 127.0.0.1.
    let reached = 0;
    const other = createServer({ key: OTHER_KEY, cert: OTHER_CA }, (_req, res) => {
      reached += 1;
      res.end('{"data":{"version":"8.2.4"}}');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    try {
      const result = await runTest({ url: `https://127.0.0.1:${(other.address() as AddressInfo).port}`, caCert: OTHER_CA });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Certificat TLS de Proxmox refusé/);
      expect(reached).toBe(0);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it('jeton refusé : message d’authentification distinct', async () => {
    const result = await runTest({ tokenSecret: '00000000-0000-4000-8000-000000000000' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/refusé le jeton API/);
  });

  it('serveur injoignable : message réseau distinct', async () => {
    // Port local libéré juste avant : la connexion est refusée.
    const closed = createTcpServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const result = await runTest({ url: `https://127.0.0.1:${port}` });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Impossible de joindre Proxmox/);
    expect(result.message).not.toMatch(/Certificat|jeton/);
  });

  it('signale les privilèges absents du jeton', async () => {
    pve.permissions = { '/vms': { 'VM.Audit': 1 } };
    const { browser } = await configure();
    pve.permissions = { '/vms': { 'VM.Audit': 1 } };
    const test = await browser.post<SettingsTestResult>('/api/settings/proxmox/test');
    expect(test.body.data.ok).toBe(true);
    expect(test.body.data.message).toContain('Privilèges absents du jeton : Sys.Audit, VM.PowerMgmt.');
  });

  it('le test de connexion exige un step-up : sans lui, aucune requête ne part vers Proxmox', async () => {
    await configure();
    const browser = await sessionWithoutStepUp();
    pve.calls.length = 0;
    const refused = await browser.post('/api/settings/proxmox/test');
    expect(refused.status).toBe(403);
    expect(refused.errorCode).toBe('STEP_UP_REQUIRED');
    expect(pve.calls).toEqual([]);

    expect((await browser.stepUp(admin)).status).toBe(200);
    const test = await browser.post<SettingsTestResult>('/api/settings/proxmox/test');
    expect(test.body.data.ok).toBe(true);
    expect(pve.calls[0]).toMatchObject({ method: 'GET', path: '/api2/json/version' });
  });

  it('le test est journalisé', async () => {
    const { browser } = await configure();
    await browser.post('/api/settings/proxmox/test');
    const row = db.prepare("SELECT success FROM audit_log WHERE action = 'settings.proxmox.test' ORDER BY id DESC LIMIT 1").get() as { success: number };
    expect(row.success).toBe(1);
  });
});

describe('proxmox — lecture', () => {
  let browser: Browser;
  beforeAll(async () => {
    await configure();
  });
  beforeEach(async () => {
    browser = await session();
    pve.calls.length = 0;
  });

  it('nodes : unités, pourcentages, node hors ligne et node illisible', async () => {
    const res = await browser.get<ProxmoxNode[]>('/api/proxmox/nodes');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        node: 'pve1',
        online: true,
        cpuPercent: 25.12,
        cpuCores: 16,
        memoryUsedBytes: 8 * GIB,
        memoryTotalBytes: 32 * GIB,
        diskUsedBytes: 20 * GIB,
        diskTotalBytes: 100 * GIB,
        uptimeSeconds: 86_400,
        loadAverage: [0.52, 0.48, 0.4],
        pveVersion: '8.2.4',
        guests: { running: 1, total: 2 }, // le modèle 101 n'est pas compté
      },
      {
        // Annoncé hors ligne par le cluster : aucune mesure, /status n'est pas appelé.
        node: 'pve2',
        online: false,
        cpuPercent: 0,
        cpuCores: 8,
        memoryUsedBytes: 0,
        memoryTotalBytes: 16 * GIB,
        diskUsedBytes: 0,
        diskTotalBytes: 50 * GIB,
        uptimeSeconds: 0,
        loadAverage: null,
        pveVersion: null,
        guests: { running: 0, total: 1 },
      },
      {
        // Annoncé en ligne mais /status répond 595 : listé hors ligne, la réponse n'échoue pas.
        node: 'pve3',
        online: false,
        cpuPercent: 10,
        cpuCores: 4,
        memoryUsedBytes: 2 * GIB,
        memoryTotalBytes: 8 * GIB,
        diskUsedBytes: 5 * GIB,
        diskTotalBytes: 40 * GIB,
        uptimeSeconds: 120,
        loadAverage: null,
        pveVersion: null,
        guests: { running: 0, total: 1 },
      },
    ]);
    const statusCalls = pve.calls.filter((c) => c.path.endsWith('/status')).map((c) => c.path).sort();
    expect(statusCalls).toEqual(['/api2/json/nodes/pve1/status', '/api2/json/nodes/pve3/status']);
    expect(pve.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(res.raw.payload).not.toContain(RAW_MARKER);
  });

  it('nodes : un privilège manquant sur /status ne fait pas passer le node hors ligne', async () => {
    pve.forced.set('GET /api2/json/nodes/pve1/status', { status: 403 });
    const res = await browser.get<ProxmoxNode[]>('/api/proxmox/nodes');
    expect(res.body.data[0]).toMatchObject({ node: 'pve1', online: true, loadAverage: null, pveVersion: null, cpuPercent: 25.12 });
  });

  it('guests : statut normalisé, modèle, tags, CPU rapporté aux cœurs, entrées invalides ignorées', async () => {
    const res = await browser.get<ProxmoxGuest[]>('/api/proxmox/guests');
    expect(res.status).toBe(200);
    expect(pve.calls).toEqual([expect.objectContaining({ method: 'GET', path: '/api2/json/cluster/resources', query: '?type=vm' })]);
    expect(res.body.data).toEqual([
      { vmid: 100, name: 'web01', node: 'pve1', type: 'qemu', status: 'running', template: false, cpuPercent: 50, cpuCores: 4, memoryUsedBytes: 2 * GIB, memoryTotalBytes: 4 * GIB, diskUsedBytes: 0, diskTotalBytes: 32 * GIB, uptimeSeconds: 3600, tags: ['prod', 'web'] },
      { vmid: 101, name: 'debian-12-modele', node: 'pve1', type: 'qemu', status: 'stopped', template: true, cpuPercent: 0, cpuCores: 2, memoryUsedBytes: 0, memoryTotalBytes: 2 * GIB, diskUsedBytes: 0, diskTotalBytes: 8 * GIB, uptimeSeconds: 0, tags: [] },
      { vmid: 200, name: 'ct-db', node: 'pve1', type: 'lxc', status: 'stopped', template: false, cpuPercent: 0, cpuCores: 2, memoryUsedBytes: 0, memoryTotalBytes: 1 * GIB, diskUsedBytes: 3 * GIB, diskTotalBytes: 10 * GIB, uptimeSeconds: 0, tags: ['db', 'interne'] },
      // Nom non fiable renvoyé tel quel (JSON) ; CPU borné à 100 ; mémoire reçue en chaîne convertie en nombre.
      { vmid: 300, name: XSS_NAME, node: 'pve3', type: 'qemu', status: 'paused', template: false, cpuPercent: 100, cpuCores: 2, memoryUsedBytes: 1 * GIB, memoryTotalBytes: 2 * GIB, diskUsedBytes: 0, diskTotalBytes: 16 * GIB, uptimeSeconds: 50, tags: [] },
      { vmid: 301, name: 'CT 301', node: 'pve2', type: 'lxc', status: 'unknown', template: false, cpuPercent: 0, cpuCores: 1, memoryUsedBytes: 0, memoryTotalBytes: 512 * 1024 ** 2, diskUsedBytes: 0, diskTotalBytes: 4 * GIB, uptimeSeconds: 0, tags: [] },
    ]);
    expect(res.raw.headers['content-type']).toMatch(/^application\/json/);
  });

  it('summary : compteurs, nodes hors ligne, sans appel par node', async () => {
    const res = await browser.get<ProxmoxSummary>('/api/proxmox/summary');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      nodes: { total: 3, online: 2 },
      guests: { total: 4, running: 1, stopped: 1 },
      offlineNodes: ['pve2'],
    });
    expect(pve.calls.map((c) => `${c.path}${c.query}`).sort()).toEqual(['/api2/json/cluster/resources?type=node', '/api2/json/cluster/resources?type=vm']);
  });

  it('summary : requête d’arrière-plan, elle ne prolonge pas la session', async () => {
    const idle = await session();
    for (let i = 0; i < 3; i += 1) {
      advance(4 * 60_000);
      expect((await idle.get('/api/proxmox/summary')).status).toBe(200);
    }
    // 16 minutes sans activité réelle (inactivité maximale : 15 minutes) malgré les interrogations.
    advance(4 * 60_000);
    expect((await idle.get('/api/proxmox/summary')).status).toBe(401);
  });

  it('cache court : une seule requête distante, y compris pour des appels simultanés', async () => {
    pve.delayMs = 50;
    const results = await Promise.all([browser.get('/api/proxmox/guests'), browser.get('/api/proxmox/guests'), browser.get('/api/proxmox/guests')]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    await browser.get('/api/proxmox/guests');
    expect(pve.calls.length).toBe(1);

    advance(10_001);
    await browser.get('/api/proxmox/guests');
    expect(pve.calls.length).toBe(2);
  });

  it('historique : valeurs manquantes → null, points triés, paramètres transmis', async () => {
    pve.rrd = [
      { time: 1_772_359_260, cpu: 0.5, memused: 4 * GIB, memtotal: 16 * GIB, loadavg: 1.234 },
      { time: 1_772_359_200, cpu: 0.031, memused: 8 * GIB, memtotal: 32 * GIB, loadavg: 0.4 },
      { time: 1_772_359_320 }, // aucune mesure sur l'intervalle
      { time: 1_772_359_380, cpu: null, memused: 1 * GIB, loadavg: 'n/a' },
      { cpu: 0.9 }, // sans horodatage : ignoré
    ];
    const res = await browser.get<ProxmoxNodeHistoryPoint[]>('/api/proxmox/nodes/pve1/history?timeframe=day');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { time: '2026-03-01T10:00:00.000Z', cpuPercent: 3.1, memoryPercent: 25, loadAverage: 0.4 },
      { time: '2026-03-01T10:01:00.000Z', cpuPercent: 50, memoryPercent: 25, loadAverage: 1.23 },
      { time: '2026-03-01T10:02:00.000Z', cpuPercent: null, memoryPercent: null, loadAverage: null },
      { time: '2026-03-01T10:03:00.000Z', cpuPercent: null, memoryPercent: null, loadAverage: null },
    ]);
    const call = pve.calls.find((c) => c.path.endsWith('/rrddata'))!;
    expect(call.path).toBe('/api2/json/nodes/pve1/rrddata');
    expect(new URLSearchParams(call.query).get('timeframe')).toBe('day');
    expect(new URLSearchParams(call.query).get('cf')).toBe('AVERAGE');
  });

  it('historique : timeframe par défaut « hour », valeur inconnue refusée', async () => {
    await browser.get('/api/proxmox/nodes/pve1/history');
    expect(new URLSearchParams(pve.calls.find((c) => c.path.endsWith('/rrddata'))!.query).get('timeframe')).toBe('hour');
    pve.calls.length = 0;
    for (const timeframe of ['month', 'year', '', 'hour&cf=MAX%26x']) {
      const res = await browser.get(`/api/proxmox/nodes/pve1/history?timeframe=${timeframe}`);
      expect(res.status, timeframe).toBe(timeframe === 'hour&cf=MAX%26x' ? 200 : 400);
    }
    // Le paramètre supplémentaire du client n'est jamais relayé à Proxmox.
    expect(pve.calls.filter((c) => c.path.endsWith('/rrddata')).every((c) => new URLSearchParams(c.query).get('cf') === 'AVERAGE')).toBe(true);
  });

  it('historique : node invalide (400) ou inconnu du cluster (404), aucun chemin distant construit', async () => {
    for (const node of ['..%2F', 'pve1%2F..%2Fpve2', 'pve1%2Fstatus', '-pve1', 'pve1-', 'pve_1', 'pve1%00', 'a'.repeat(64), 'pve1%3Fx=1']) {
      const res = await browser.get(`/api/proxmox/nodes/${node}/history`);
      expect(res.status, node).toBe(400);
    }
    // Segment « .. » littéral : résolu par l'analyse d'URL avant le routage (404) ou rejeté par la validation (400).
    for (const node of ['..', '%2E%2E']) {
      expect([400, 404], node).toContain((await browser.get(`/api/proxmox/nodes/${node}/history`)).status);
    }
    expect(pve.calls).toEqual([]);

    const unknown = await browser.get('/api/proxmox/nodes/pve9/history');
    expect(unknown.status).toBe(404);
    expect(pve.calls.some((c) => c.path.includes('rrddata') || c.path.includes('pve9'))).toBe(false);
  });

  it('erreurs distantes : 502 avec message sobre, sans corps brut ni secret', async () => {
    const cases: [number, RegExp][] = [
      [401, /refusé le jeton API/],
      [403, /privilèges nécessaires/],
      [500, /erreur interne/],
      [595, /injoignable/],
    ];
    for (const [status, message] of cases) {
      advance(10_001);
      pve.forced.set('GET /api2/json/cluster/resources', { status });
      const res = await browser.get('/api/proxmox/guests');
      expect(res.status).toBe(502);
      expect(res.errorCode).toBe('UPSTREAM_ERROR');
      expect(res.body.error!.message).toMatch(message);
      expect(res.body.error!.details).toMatchObject({ integration: 'proxmox', status });
      expect(res.raw.payload).not.toContain(RAW_MARKER);
      expect(res.raw.payload).not.toContain(TOKEN_SECRET);
      expect(res.raw.payload).not.toContain('127.0.0.1');
    }
    // Une erreur n'est pas mise en cache.
    pve.forced.clear();
    expect((await browser.get('/api/proxmox/guests')).status).toBe(200);
  });

  it('réponse qui n’est pas celle de l’API : 502 « illisible »', async () => {
    pve.forced.set('GET /api2/json/cluster/resources', { status: 200, body: 'pas un objet' });
    const res = await browser.get('/api/proxmox/guests');
    expect(res.status).toBe(502);
    expect(res.body.error!.message).toMatch(/inattendue|illisible/);
  });

  it('les GET ne modifient rien : aucune écriture au journal, aucun POST distant', async () => {
    const before = proxmoxAudit().length;
    await browser.get('/api/proxmox/nodes');
    await browser.get('/api/proxmox/guests');
    await browser.get('/api/proxmox/summary');
    await browser.get('/api/proxmox/nodes/pve1/history');
    expect(proxmoxAudit().length).toBe(before);
    expect(posts()).toEqual([]);
  });
});

describe('proxmox — actions sur un invité', () => {
  beforeAll(async () => {
    await configure();
  });

  it('start : sans step-up, chemin exact, journal', async () => {
    const browser = await sessionWithoutStepUp();

    const start = await browser.post<GuestActionResult>(actionUrl('pve1', 'lxc', 200), { action: 'start' });
    expect(start.status).toBe(200);
    expect(start.body.data).toEqual({ taskId: `UPID:pve1:0001E240:0A1B2C3D:65F0A1B2:vzstart:200:${TOKEN_ID}:` });
    expect(posts()).toEqual([expect.objectContaining({ path: '/api2/json/nodes/pve1/lxc/200/status/start', authorization: `PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}` })]);
    expect(lastAudit()).toMatchObject({ action: 'proxmox.guest.start', target: 'CT 200 (ct-db) @ pve1', success: 1 });
    expect(lastAudit().parsed).toEqual({ node: 'pve1', type: 'lxc', vmid: 200, taskId: start.body.data.taskId });

    const again = await browser.post<GuestActionResult>(actionUrl('pve1', 'qemu', 100), { action: 'start' });
    expect(again.status).toBe(200);
    expect(posts().at(-1)!.path).toBe('/api2/json/nodes/pve1/qemu/100/status/start');
    expect(lastAudit()).toMatchObject({ action: 'proxmox.guest.start', target: 'VM 100 (web01) @ pve1', success: 1 });
    // L'existence de l'invité est vérifiée auprès de Proxmox avant chaque action.
    expect(pve.calls.filter((c) => c.path === '/api2/json/cluster/resources').length).toBe(2);
  });

  it('shutdown, stop et reboot : step-up exigé avant tout appel distant', async () => {
    const browser = await sessionWithoutStepUp();
    const before = proxmoxAudit().length;
    for (const action of ['shutdown', 'stop', 'reboot']) {
      const res = await browser.post(actionUrl('pve1', 'qemu', 100), { action });
      expect(res.status, action).toBe(403);
      expect(res.errorCode).toBe('STEP_UP_REQUIRED');
    }
    expect(pve.calls).toEqual([]);
    expect(proxmoxAudit().length).toBe(before);

    expect((await browser.stepUp(admin)).status).toBe(200);
    for (const action of ['shutdown', 'stop', 'reboot']) {
      const res = await browser.post<GuestActionResult>(actionUrl('pve1', 'qemu', 100), { action });
      expect(res.status, action).toBe(200);
      expect(res.body.data.taskId).toMatch(new RegExp(`^UPID:pve1:.*:qm${action}:100:`));
      expect(lastAudit()).toMatchObject({ action: `proxmox.guest.${action}`, target: 'VM 100 (web01) @ pve1', success: 1 });
    }
    expect(posts().map((c) => c.path)).toEqual([
      '/api2/json/nodes/pve1/qemu/100/status/shutdown',
      '/api2/json/nodes/pve1/qemu/100/status/stop',
      '/api2/json/nodes/pve1/qemu/100/status/reboot',
    ]);

    // La fenêtre de step-up expire : arrêt et redémarrage sont de nouveau refusés, le démarrage reste permis.
    advance(5 * 60_000 + 1_000);
    expect((await browser.post(actionUrl('pve1', 'qemu', 100), { action: 'stop' })).errorCode).toBe('STEP_UP_REQUIRED');
    expect((await browser.post(actionUrl('pve1', 'qemu', 100), { action: 'reboot' })).errorCode).toBe('STEP_UP_REQUIRED');
    expect((await browser.post(actionUrl('pve1', 'qemu', 100), { action: 'start' })).status).toBe(200);
  });

  it('la validation précède le step-up : une action inconnue donne 400, pas 403', async () => {
    const browser = await sessionWithoutStepUp();
    const res = await browser.post(actionUrl('pve1', 'qemu', 100), { action: 'destroy' });
    expect(res.status).toBe(400);
    expect(pve.calls).toEqual([]);
  });

  it('paramètres de chemin invalides : 400 et aucune requête distante', async () => {
    const browser = await session();
    const invalid: [string, string, string][] = [
      // traversée et séparateurs encodés dans :node
      ['..%2F..%2Faccess', 'qemu', '100'],
      ['pve1%2F..%2Fpve2', 'qemu', '100'],
      ['pve1%2Fqemu%2F101', 'qemu', '100'],
      ['pve1%5C..', 'qemu', '100'],
      ['pve1%3Fforce=1', 'qemu', '100'],
      ['pve1%23', 'qemu', '100'],
      ['pve1%0d%0aHost:%20evil', 'qemu', '100'],
      ['-pve1', 'qemu', '100'],
      ['pve1.exemple.com', 'qemu', '100'],
      ['a'.repeat(64), 'qemu', '100'],
      // type inconnu
      ['pve1', 'storage', '100'],
      ['pve1', 'QEMU', '100'],
      ['pve1', 'qemu%2F100%2Fstatus', '100'],
      // vmid hors bornes ou mal formé
      ['pve1', 'qemu', '99'],
      ['pve1', 'qemu', '0'],
      ['pve1', 'qemu', '-100'],
      ['pve1', 'qemu', '1000000000'],
      ['pve1', 'qemu', '0100'],
      ['pve1', 'qemu', '100.5'],
      ['pve1', 'qemu', '1e3'],
      ['pve1', 'qemu', '0x64'],
      ['pve1', 'qemu', '100abc'],
      ['pve1', 'qemu', '100%2F..%2F101'],
      ['pve1', 'qemu', '%20100'],
    ];
    const before = proxmoxAudit().length;
    for (const [node, type, vmid] of invalid) {
      const res = await browser.post(actionUrl(node, type, vmid), { action: 'start' });
      expect(res.status, `${node} ${type} ${vmid}`).toBe(400);
      expect(res.errorCode).toBe('VALIDATION_ERROR');
    }
    // Segment « .. » littéral : résolu par l'analyse d'URL avant le routage (404) ou rejeté par la validation (400).
    for (const url of [actionUrl('..', 'qemu', 100), actionUrl('%2E%2E', 'qemu', 100), actionUrl('pve1', '..', 100), actionUrl('pve1', 'qemu', '..')]) {
      expect([400, 404], url).toContain((await browser.post(url, { action: 'start' })).status);
    }

    for (const body of [{}, { action: 'kill' }, { action: 'start', force: true }, { action: ['start'] }]) {
      expect((await browser.post(actionUrl('pve1', 'qemu', 100), body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(pve.calls).toEqual([]);
    expect(proxmoxAudit().length).toBe(before);
  });

  it('validateurs de segments : « .. », séparateurs et bornes', () => {
    for (const node of ['..', '.', '', 'pve1/..', 'pve1\\x', 'pve1%2F','-pve1', 'pve1-', 'pve_1', 'pve1.lan', 'pve1 ', 'a'.repeat(64), 100, null]) expect(isNodeName(node), String(node)).toBe(false);
    for (const node of ['pve1', 'a', 'PVE-node-01', 'a'.repeat(63)]) expect(isNodeName(node), node).toBe(true);
    for (const vmid of [99, 0, -100, 1_000_000_000, 100.5, Number.NaN, '100']) expect(isVmid(vmid), String(vmid)).toBe(false);
    for (const vmid of [100, 999_999_999]) expect(isVmid(vmid)).toBe(true);
  });

  it('bornes de vmid acceptées par la validation (l’invité doit ensuite exister)', async () => {
    const browser = await session();
    for (const vmid of ['100', '999999999']) {
      const res = await browser.post(actionUrl('pve1', 'qemu', vmid), { action: 'start' });
      expect(res.status, vmid).toBe(vmid === '100' ? 200 : 404);
    }
  });

  it('invité inexistant, mauvais node ou mauvais type : 404, aucun POST, échec journalisé', async () => {
    const browser = await session();
    const cases: [string, string, number, string][] = [
      ['pve1', 'qemu', 999, 'VM 999 @ pve1'],
      ['pve2', 'qemu', 100, 'VM 100 @ pve2'], // la VM 100 existe, mais sur pve1
      ['pve1', 'lxc', 100, 'CT 100 @ pve1'], // 100 est une VM, pas un conteneur
      ['pve9', 'qemu', 100, 'VM 100 @ pve9'], // node inconnu
      ['pve1', 'qemu', 400, 'VM 400 @ pve1'], // entrée Proxmox au node invalide : ignorée
    ];
    for (const [node, type, vmid, target] of cases) {
      const res = await browser.post(actionUrl(node, type, vmid), { action: 'start' });
      expect(res.status, target).toBe(404);
      expect(res.errorCode).toBe('NOT_FOUND');
      expect(lastAudit()).toMatchObject({ action: 'proxmox.guest.start', target, success: 0 });
      expect(lastAudit().parsed).toMatchObject({ node, type, vmid, code: 'NOT_FOUND' });
    }
    expect(posts()).toEqual([]);
  });

  it('refuse d’agir sur un modèle', async () => {
    const browser = await session();
    for (const action of ['start', 'reboot', 'shutdown', 'stop']) {
      const res = await browser.post(actionUrl('pve1', 'qemu', 101), { action });
      expect(res.status, action).toBe(400);
      expect(res.body.error!.message).toMatch(/modèle/);
      expect(lastAudit()).toMatchObject({ action: `proxmox.guest.${action}`, target: 'VM 101 (debian-12-modele) @ pve1', success: 0 });
    }
    expect(posts()).toEqual([]);
  });

  it('échec côté Proxmox : 502 sobre, échec journalisé sans corps brut', async () => {
    const browser = await session();
    const cases: [number, RegExp][] = [
      [500, /refusé l’action/],
      [403, /VM\.PowerMgmt/],
      [595, /injoignable/],
    ];
    for (const [status, message] of cases) {
      pve.forced.set('POST /api2/json/nodes/pve1/qemu/100/status/stop', { status });
      const res = await browser.post(actionUrl('pve1', 'qemu', 100), { action: 'stop' });
      expect(res.status).toBe(502);
      expect(res.body.error!.message).toMatch(message);
      expect(res.raw.payload).not.toContain(RAW_MARKER);
      expect(res.raw.payload).not.toContain(TOKEN_SECRET);
      const entry = lastAudit();
      expect(entry).toMatchObject({ action: 'proxmox.guest.stop', target: 'VM 100 (web01) @ pve1', success: 0 });
      expect(entry.parsed).toMatchObject({ code: 'UPSTREAM_ERROR' });
      expect(entry.details).not.toContain(RAW_MARKER);
    }
  });

  it('le nom venant de Proxmox est journalisé sans caractère de contrôle et borné', async () => {
    pve.resources.push({ id: 'qemu/500', type: 'qemu', vmid: 500, node: 'pve1', name: `ligne1\r\nligne2\u0000${'x'.repeat(200)}`, status: 'stopped' });
    const browser = await session();
    expect((await browser.post(actionUrl('pve1', 'qemu', 500), { action: 'start' })).status).toBe(200);
    const target = lastAudit().target!;
    expect(target).toBe(`VM 500 (${`ligne1ligne2${'x'.repeat(200)}`.slice(0, 80)}) @ pve1`);
  });

  it('une action invalide le cache', async () => {
    const browser = await session();
    await browser.get('/api/proxmox/guests');
    await browser.get('/api/proxmox/guests');
    expect(pve.calls.length).toBe(1);

    await browser.post(actionUrl('pve1', 'lxc', 200), { action: 'start' });
    pve.resources.find((r) => r.vmid === 200)!.status = 'running';
    pve.calls.length = 0;
    const after = await browser.get<ProxmoxGuest[]>('/api/proxmox/guests');
    expect(pve.calls.length).toBe(1);
    expect(after.body.data.find((g) => g.vmid === 200)!.status).toBe('running');
  });

  it('aucun secret dans le journal ni dans les réponses', async () => {
    const all = db.prepare('SELECT action, target, details FROM audit_log').all();
    expect(JSON.stringify(all)).not.toContain(TOKEN_SECRET);
    expect(JSON.stringify(all)).not.toContain('PVEAPIToken');
  });

  it('changer les réglages vide le cache et repart sur une nouvelle connexion', async () => {
    const browser = await session();
    await browser.get('/api/proxmox/guests');
    expect(pve.calls.length).toBe(1);
    // Passage à une CA étrangère : la lecture suivante doit échouer en TLS, pas servir l'ancien cache.
    expect((await browser.put('/api/settings/proxmox', { caCert: OTHER_CA, tokenSecret: TOKEN_SECRET })).status).toBe(200);
    const res = await browser.get('/api/proxmox/guests');
    expect(res.status).toBe(502);
    expect(res.body.error!.message).toMatch(/Certificat TLS/);
    expect(pve.calls.length).toBe(1);

    expect((await browser.put('/api/settings/proxmox', { caCert: TEST_CERT, tokenSecret: TOKEN_SECRET })).status).toBe(200);
    expect((await browser.get('/api/proxmox/guests')).status).toBe(200);
  });
});
