/**
 * Audit 4 — étanchéité entre les deux administrateurs (boîtes mail personnelles, préférences, push).
 *
 * Chaque test affirme le comportement SÛR attendu : un test « F-xx » échoue tant que la faille existe ; un test
 * « vérifié » documente une propriété contrôlée et tenue.
 */
import { createECDH, randomBytes } from 'node:crypto';
import type { MailAccount, MailUnreadSummary, PanelNotification, UserPreferences } from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ───────────────────────────── Faux IMAP / SMTP / WHMCS / HTTP sortant ─────────────────────────────

const mock = vi.hoisted(() => {
  interface Server {
    password: string;
    folders: { path: string; name: string }[];
    /** Si défini, `connect()` attend cette promesse (simule un serveur lent). */
    hold: Promise<void> | null;
  }
  const servers = new Map<string, Server>();
  const connects: string[] = [];
  class FakeImapFlow {
    usable = false;
    secureConnection = true;
    constructor(public options: Record<string, any>) {}
    on(): this {
      return this;
    }
    async connect(): Promise<void> {
      connects.push(this.options.host);
      const server = servers.get(this.options.host);
      if (!server) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      if (server.hold) await server.hold;
      if (this.options.auth.pass !== server.password) throw Object.assign(new Error('auth'), { authenticationFailed: true });
      this.usable = true;
    }
    async list(): Promise<unknown[]> {
      const server = servers.get(this.options.host)!;
      return server.folders.map((f) => ({ path: f.path, name: f.name, delimiter: '/', flags: new Set(), status: { messages: 3, unseen: 2 } }));
    }
    async status(): Promise<unknown> {
      return { path: 'INBOX', unseen: 2 };
    }
    async noop(): Promise<void> {}
    async logout(): Promise<void> {
      this.usable = false;
    }
    close(): void {
      this.usable = false;
    }
  }
  const smtpSent: unknown[] = [];
  const createTransport = (options: Record<string, any>) => ({
    options,
    async verify() {
      return true;
    },
    async sendMail(message: Record<string, any>) {
      smtpSent.push(message);
      return { messageId: message.messageId, accepted: [], rejected: [] };
    },
    close() {},
  });
  const fetchCalls: string[] = [];
  return { servers, connects, FakeImapFlow, createTransport, smtpSent, fetchCalls };
});

vi.mock('imapflow', () => ({ ImapFlow: mock.FakeImapFlow }));
vi.mock('nodemailer', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createTransport: mock.createTransport, default: { ...(actual.default as object), createTransport: mock.createTransport } };
});
vi.mock('../src/modules/whmcs/service.js', () => ({
  isWhmcsConfigured: () => true,
  findClientByEmail: async () => null,
  findClientsByEmails: async () => new Map(),
}));
vi.mock('../src/core/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/http.js')>()),
  upstreamFetch: async (_integration: string, url: string | URL) => {
    mock.fetchCalls.push(String(url));
    return new Response(null, { status: 201 });
  },
}));

import { flushAlerts, resetAlertThrottle } from '../src/core/alerts.js';
import { outbox } from '../src/core/mailer.js';
import { db } from '../src/db/index.js';
import { saveSubscription } from '../src/modules/notifications/push.js';
import { flushNotifications, notify } from '../src/modules/notifications/service.js';
import { advance, Browser, buildTestApp, createTestAdmin, uniqueIp, useFakeClock, type TestAdmin, type TestResponse } from './helpers.js';

// ───────────────────────────── Données ─────────────────────────────

const SECRET_ADDRESS = 'alice.medical@exemple.test';
const SECRET_LABEL = 'Santé Alice';
const personalInput = {
  label: SECRET_LABEL,
  address: SECRET_ADDRESS,
  imapHost: 'imap.alice-perso.test',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.alice-perso.test',
  smtpPort: 465,
  smtpSecure: true,
  username: 'alice-perso',
  password: 'mdp-Alice-Perso-Secret-9',
  visibility: 'personal',
};
const sharedInput = {
  label: 'Support commun',
  address: 'support@exemple.test',
  imapHost: 'imap.shared.test',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.shared.test',
  smtpPort: 465,
  smtpSecure: true,
  username: 'support',
  password: 'mdp-Support-Commun-7',
  visibility: 'shared',
};

let app: FastifyInstance;
let alice: TestAdmin;
let bob: TestAdmin;
let aliceBrowser: Browser;
let bobBrowser: Browser;

async function stepUp(browser: Browser, admin: TestAdmin): Promise<void> {
  const res = await browser.stepUp(admin);
  if (res.status !== 200) throw new Error(`step-up refusé : ${res.status}`);
}

async function create(browser: Browser, admin: TestAdmin, input: Record<string, unknown>): Promise<MailAccount> {
  await stepUp(browser, admin);
  const res = await browser.post<MailAccount>('/api/mail/accounts', input);
  if (res.status !== 201) throw new Error(`création refusée : ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

const auditCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
const notificationCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n;

/** En-têtes comparables entre deux réponses (sans ce qui varie par nature : date, identifiant de requête, cookies). */
function stableHeaders(res: TestResponse): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(res.raw.headers)) {
    if (['date', 'x-request-id', 'set-cookie', 'content-length'].includes(name)) continue;
    out[name] = value;
  }
  return out;
}

async function call(browser: Browser, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: Record<string, unknown>) {
  if (method === 'GET') return browser.get(url);
  if (method === 'DELETE') return browser.delete(url);
  if (method === 'PUT') return browser.put(url, body ?? {});
  return browser.post(url, body ?? {});
}

const everyRoute = (id: string | number) =>
  [
    ['GET', `/api/mail/accounts/${id}/folders`],
    ['GET', `/api/mail/accounts/${id}/messages`],
    ['GET', `/api/mail/accounts/${id}/messages/1`],
    ['GET', `/api/mail/accounts/${id}/messages/1/attachments/2`],
    ['POST', `/api/mail/accounts/${id}/messages/1/flags`, { seen: true }],
    ['POST', `/api/mail/accounts/${id}/messages/1/move`, { destination: 'Corbeille' }],
    ['DELETE', `/api/mail/accounts/${id}/messages/1`],
    ['POST', `/api/mail/accounts/${id}/send`, { to: ['x@exemple.test'], subject: 'Objet', text: 'Texte' }],
    ['POST', `/api/mail/accounts/${id}/send`, { to: ['x@exemple.test'], subject: 'Re', text: 'T', inReplyTo: { folder: 'INBOX', uid: 1 } }],
    ['POST', `/api/mail/accounts/${id}/test`, {}],
    ['PUT', `/api/mail/accounts/${id}`, { ...personalInput, visibility: 'shared' }],
    ['PUT', `/api/mail/accounts/${id}`, { ...personalInput, visibility: 'personal' }],
    ['DELETE', `/api/mail/accounts/${id}`],
  ] as ['GET' | 'POST' | 'PUT' | 'DELETE', string, Record<string, unknown>?][];

beforeAll(async () => {
  useFakeClock();
  app = await buildTestApp();
  alice = await createTestAdmin('alice');
  bob = await createTestAdmin('bob');
  aliceBrowser = new Browser(app, uniqueIp());
  bobBrowser = new Browser(app, uniqueIp());
  await aliceBrowser.login(alice);
  await bobBrowser.login(bob);
});

beforeEach(async () => {
  advance(31_000); // le cache des non-lus (30 s) expire entre deux tests
  resetAlertThrottle();
  mock.servers.clear();
  mock.servers.set('imap.alice-perso.test', { password: personalInput.password, folders: [{ path: 'INBOX', name: 'INBOX' }, { path: 'Dossier-médical', name: 'Dossier-médical' }], hold: null });
  mock.servers.set('imap.shared.test', { password: sharedInput.password, folders: [{ path: 'INBOX', name: 'INBOX' }], hold: null });
  mock.connects.length = 0;
  mock.smtpSent.length = 0;
  // Garde les deux sessions actives malgré les avances d'horloge.
  expect((await aliceBrowser.get('/api/mail/accounts')).status).toBe(200);
  expect((await bobBrowser.get('/api/mail/accounts')).status).toBe(200);
});

afterAll(async () => {
  await app.close();
});

// ───────────────────────────── Contrôle d'accès des routes ─────────────────────────────

describe('routes /api/mail/** face à la boîte personnelle de l’autre', () => {
  it('vérifié — chaque route : statut, corps et en-têtes identiques à un compte inexistant ; aucune connexion, aucun audit, aucune alerte', async () => {
    const personal = await create(aliceBrowser, alice, personalInput);
    await stepUp(bobBrowser, bob);
    await flushAlerts();
    const audits = auditCount();
    const notifications = notificationCount();
    const mails = outbox.length;
    for (const [method, url, body] of everyRoute(personal.id)) {
      const other = await call(bobBrowser, method, url, body);
      const missing = await call(bobBrowser, method, url.replace(`/accounts/${personal.id}`, '/accounts/987654'), body);
      expect(other.status, `${method} ${url}`).toBe(404);
      expect(other.body, `${method} ${url}`).toEqual(missing.body);
      expect(stableHeaders(other), `${method} ${url}`).toEqual(stableHeaders(missing));
    }
    await flushAlerts();
    expect(mock.connects).toEqual([]);
    expect(mock.smtpSent).toEqual([]);
    expect(auditCount()).toBe(audits);
    expect(notificationCount()).toBe(notifications);
    expect(outbox.length).toBe(mails);
    // Rien n'a bougé côté base.
    expect(db.prepare('SELECT label, owner_user_id FROM mail_accounts WHERE id = ?').get(personal.id)).toEqual({ label: SECRET_LABEL, owner_user_id: alice.user.id });
  });

  it('vérifié — identifiants non entiers, encodés ou hors bornes : 400 identique pour la boîte de l’autre et un inexistant', async () => {
    const personal = await create(aliceBrowser, alice, personalInput);
    const id = String(personal.id);
    const variants: ((x: string) => string)[] = [
      (x) => `0${x}`,
      (x) => `${x}.0`,
      (x) => `+${x}`,
      (x) => `%20${x}`,
      (x) => `${x}%00`,
      (x) => `0x${Number(x).toString(16)}`,
      (x) => `${x}e0`,
      (x) => `${x}%20`,
      (x) => `-${x}`,
      (x) => `${x}00000000000`,
      (x) => `${x}%2F`,
      (x) => `${x}%2C1`,
    ];
    for (const variant of variants) {
      const res = await bobBrowser.get(`/api/mail/accounts/${variant(id)}/folders`);
      const ref = await bobBrowser.get(`/api/mail/accounts/${variant('987654')}/folders`);
      expect([400, 404], variant(id)).toContain(res.status);
      expect(res.status, variant(id)).toBe(ref.status);
      expect(res.body, variant(id)).toEqual(ref.body);
    }
    // Encodage pourcent de chiffres : Fastify décode le paramètre ; on vérifie qu'il est traité comme l'id lui-même (accès refusé).
    const encoded = await bobBrowser.get(`/api/mail/accounts/${[...id].map((c) => `%3${c}`).join('')}/folders`);
    expect(encoded.status).toBe(404);
    expect(mock.connects).toEqual([]);
  });

  it('vérifié (mesure) — temps de réponse : la boîte de l’autre n’est pas distinguable d’un compte inexistant', async () => {
    const personal = await create(aliceBrowser, alice, personalInput);
    const samples = { other: [] as number[], missing: [] as number[] };
    for (let i = 0; i < 300; i += 1) {
      // Limite globale de 300 requêtes/min par IP : nouvelle fenêtre toutes les 100 paires.
      if (i % 100 === 0) {
        advance(61_000);
        expect((await bobBrowser.get('/api/mail/accounts')).status).toBe(200);
      }
      for (const [key, id] of (i % 2 ? [['other', personal.id], ['missing', 987654]] : [['missing', 987654], ['other', personal.id]]) as [keyof typeof samples, number][]) {
        const start = process.hrtime.bigint();
        const res = await bobBrowser.get(`/api/mail/accounts/${id}/messages/1`);
        samples[key].push(Number(process.hrtime.bigint() - start) / 1e6);
        expect(res.status).toBe(404);
      }
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    const other = median(samples.other);
    const missing = median(samples.missing);
    console.log(`[audit4] médiane 404 boîte de l'autre = ${other.toFixed(3)} ms ; compte inexistant = ${missing.toFixed(3)} ms`);
    expect(Math.abs(other - missing)).toBeLessThan(Math.max(0.5, missing * 0.25));
  });

  it('vérifié — listes, résumé des non-lus et plafond de comptes ignorent la boîte personnelle de l’autre', async () => {
    await create(aliceBrowser, alice, personalInput);
    const list = await bobBrowser.get<MailAccount[]>('/api/mail/accounts');
    expect(JSON.stringify(list.body)).not.toMatch(/alice\.medical|Santé Alice|alice-perso/);
    const summary = await bobBrowser.get<MailUnreadSummary>('/api/mail/unread-summary');
    expect(JSON.stringify(summary.body)).not.toMatch(/alice\.medical|Santé Alice/);
    expect(mock.connects.filter((h) => h === 'imap.alice-perso.test')).toEqual([]);
    // Même adresse qu'une boîte personnelle de l'autre : acceptée (aucune contrainte d'unicité qui trahirait l'existence).
    const dup = await create(bobBrowser, bob, { ...personalInput, label: 'Bob', password: 'x-Bob-Mdp-1' });
    expect(dup.address).toBe(SECRET_ADDRESS);
    expect(dup.ownedByMe).toBe(true);
  });

  it('vérifié — B ne peut ni s’approprier ni partager la boîte personnelle de A (même en forçant un propriétaire dans le corps)', async () => {
    const personal = await create(aliceBrowser, alice, personalInput);
    await stepUp(bobBrowser, bob);
    for (const extra of [{ ownerUserId: bob.user.id }, { owner_user_id: bob.user.id }, { id: personal.id }, { ownedByMe: true }]) {
      expect((await bobBrowser.put(`/api/mail/accounts/${personal.id}`, { ...personalInput, ...extra })).status).toBe(400);
      expect((await bobBrowser.post('/api/mail/accounts', { ...personalInput, ...extra })).status).toBe(400);
    }
    expect(db.prepare('SELECT owner_user_id FROM mail_accounts WHERE id = ?').get(personal.id)).toEqual({ owner_user_id: alice.user.id });
  });

  it('vérifié — une boîte partagée rendue personnelle par A disparaît aussitôt pour B, cache des non-lus compris', async () => {
    const shared = await create(aliceBrowser, alice, sharedInput);
    const before = await bobBrowser.get<MailUnreadSummary>('/api/mail/unread-summary');
    expect(before.body.data.accounts.map((a) => a.accountId)).toContain(shared.id);
    await stepUp(aliceBrowser, alice);
    const { password: _p, ...withoutPassword } = sharedInput;
    expect((await aliceBrowser.put(`/api/mail/accounts/${shared.id}`, { ...withoutPassword, visibility: 'personal' })).status).toBe(200);
    const after = await bobBrowser.get<MailUnreadSummary>('/api/mail/unread-summary');
    expect(after.body.data.accounts.map((a) => a.accountId)).not.toContain(shared.id);
    expect((await bobBrowser.get(`/api/mail/accounts/${shared.id}/folders`)).status).toBe(404);
  });
});

// ───────────────────────────── Constats ─────────────────────────────

describe('constats', () => {
  it('F-01 — B ne doit pas apprendre l’existence d’une boîte personnelle de A (alerte « Compte mail personnel ajouté/modifié/supprimé » diffusée aux deux)', async () => {
    await flushAlerts();
    await flushNotifications();
    outbox.length = 0;
    const startNotif = (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM notifications').get() as { m: number }).m;
    const personal = await create(aliceBrowser, alice, personalInput);
    await stepUp(aliceBrowser, alice);
    expect((await aliceBrowser.delete(`/api/mail/accounts/${personal.id}`)).status).toBe(200);
    await flushAlerts();
    await flushNotifications();

    // Centre de notifications de Bob (même chose sur SSE, push et Discord) :
    const notifs = await bobBrowser.get<PanelNotification[]>('/api/notifications?pageSize=100');
    const visibleToBob = notifs.body.data.filter((n) => n.id > startNotif).map((n) => `${n.title} — ${n.body}`);
    const mailsToBob = outbox.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(bob.email)).map((m) => m.subject);
    expect({ visibleToBob: visibleToBob.filter((t) => /personnel/i.test(t)), mailsToBob: mailsToBob.filter((s) => /personnel/i.test(s)) }).toEqual({ visibleToBob: [], mailsToBob: [] });
  });

  it('F-02 — les identifiants séquentiels ne doivent pas révéler à B qu’une boîte invisible a été créée entre deux de ses créations', async () => {
    const first = await create(bobBrowser, bob, { ...sharedInput, label: 'B1' });
    await create(aliceBrowser, alice, personalInput);
    const second = await create(bobBrowser, bob, { ...sharedInput, label: 'B2' });
    const visible = (await bobBrowser.get<MailAccount[]>('/api/mail/accounts')).body.data.map((a) => a.id);
    const hidden = Array.from({ length: second.id - first.id - 1 }, (_, i) => first.id + 1 + i).filter((id) => !visible.includes(id));
    // Comportement sûr : aucun « trou » déductible (identifiants opaques/aléatoires) — ici Bob en déduit l'id exact de la boîte d'Alice.
    expect(hidden).toEqual([]);
  });

  it('F-03 — une requête de B déjà acceptée sur une boîte partagée ne doit rien renvoyer après que A l’a rendue personnelle (contrôle unique avant I/O)', async () => {
    const shared = await create(aliceBrowser, alice, sharedInput);
    // Le serveur IMAP est lent : la requête de Bob passe le contrôle d'accès puis attend la connexion.
    let release!: () => void;
    const server = mock.servers.get('imap.shared.test')!;
    server.folders.push({ path: 'Privé-Alice', name: 'Privé-Alice' });
    server.hold = new Promise<void>((resolve) => (release = resolve));
    const pending = bobBrowser.get<{ path: string }[]>(`/api/mail/accounts/${shared.id}/folders`);
    for (let i = 0; i < 50 && !mock.connects.includes('imap.shared.test'); i += 1) await new Promise((r) => setImmediate(r));
    expect(mock.connects).toContain('imap.shared.test');

    // Alice rend la boîte personnelle pendant ce temps (mot de passe inchangé).
    await stepUp(aliceBrowser, alice);
    const { password: _p, ...withoutPassword } = sharedInput;
    expect((await aliceBrowser.put(`/api/mail/accounts/${shared.id}`, { ...withoutPassword, visibility: 'personal' })).status).toBe(200);
    server.hold = null;
    release();
    const res = await pending;
    // Comportement sûr : 404 (droit revérifié après l'attente / avant de renvoyer des données).
    expect({ status: res.status, leaked: JSON.stringify(res.body).includes('Privé-Alice') }).toEqual({ status: 404, leaked: false });
  });

  it('vérifié — suppression d’un administrateur : impossible tant que le journal est en ajout seul (aucune fuite de son journal vers l’autre)', async () => {
    // Aucune commande CLI de suppression n'existe. Un `DELETE FROM users` est refusé : la clé étrangère
    // audit_log.user_id ON DELETE SET NULL se heurte au déclencheur « ajout seul » du journal.
    await create(aliceBrowser, alice, { ...personalInput, address: 'alice.journal@exemple.test' });
    expect(() => db.prepare('DELETE FROM users WHERE id = ?').run(alice.user.id)).toThrow(/ajout seul/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mail_accounts WHERE owner_user_id = ?').get(alice.user.id)).toMatchObject({ n: expect.any(Number) });
    expect((db.prepare('SELECT COUNT(*) AS n FROM mail_accounts WHERE owner_user_id = ?').get(alice.user.id) as { n: number }).n).toBeGreaterThan(0);
    const audit = await bobBrowser.get('/api/security/audit?pageSize=100');
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).not.toContain('alice.journal@exemple.test');
  });
});

// ───────────────────────────── Préférences et push (Alice supprimée par F-04 : recréée si besoin) ─────────────────────────────

describe('préférences et push', () => {
  let carol: TestAdmin;
  let carolBrowser: Browser;

  beforeAll(async () => {
    // Alice a été supprimée par F-04 ; un nouvel administrateur prend la place (2 au maximum).
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(alice.user.id)) {
      carol = await createTestAdmin('carol');
    } else {
      carol = alice;
    }
    carolBrowser = new Browser(app, uniqueIp());
    await carolBrowser.login(carol);
  });

  beforeEach(async () => {
    expect((await carolBrowser.get('/api/me/preferences')).status).toBe(200);
  });

  it('vérifié — lecture/écriture limitées au compte connecté, aucun moyen de viser l’autre', async () => {
    expect((await carolBrowser.put<UserPreferences>('/api/me/preferences', { theme: 'light', push: { orders: false } })).status).toBe(200);
    const bobPrefs = await bobBrowser.get<UserPreferences>('/api/me/preferences');
    expect(bobPrefs.body.data.theme).toBe('dark');
    expect(bobPrefs.body.data.push.orders).toBe(true);
    for (const body of [{ userId: carol.user.id, theme: 'system' }, { user_id: carol.user.id }, { theme: 'system', id: carol.user.id }]) {
      expect((await bobBrowser.put('/api/me/preferences', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await bobBrowser.get(`/api/me/preferences?userId=${carol.user.id}`)).body).toEqual(bobPrefs.body);
    expect((await bobBrowser.get(`/api/me/preferences/${carol.user.id}`)).status).toBe(404);
    // Pollution de prototype : rejetée par l'analyseur JSON ou par le schéma strict.
    for (const raw of ['{"__proto__":{"theme":"light"}}', '{"constructor":{"prototype":{"x":1}}}', '{"push":{"__proto__":{"orders":false}}}']) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/me/preferences',
        payload: raw,
        headers: {
          'content-type': 'application/json',
          origin: 'https://panel.test',
          'x-csrf-token': bobBrowser.csrfToken!,
          cookie: [...bobBrowser.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          'user-agent': bobBrowser.userAgent,
        },
        remoteAddress: bobBrowser.ip,
      });
      expect(res.statusCode, raw).toBe(400);
    }
    expect(({} as Record<string, unknown>).theme).toBeUndefined();
    expect((await carolBrowser.get<UserPreferences>('/api/me/preferences')).body.data).toMatchObject({ theme: 'light', push: { orders: false } });
  });

  it('vérifié — defaultAccountId vers la boîte de l’autre : aucune différence avec un id inexistant, jamais utilisé côté serveur', async () => {
    const personal = await create(carolBrowser, carol, personalInput);
    const toOther = await bobBrowser.put<UserPreferences>('/api/me/preferences', { mail: { defaultAccountId: personal.id } });
    const toMissing = await bobBrowser.put<UserPreferences>('/api/me/preferences', { mail: { defaultAccountId: 987654 } });
    expect(toOther.status).toBe(toMissing.status);
    expect(toOther.body.data.mail.defaultAccountId).toBe(personal.id);
    expect((await bobBrowser.put('/api/me/preferences', { mail: { defaultAccountId: personal.id } })).body.data).toEqual(toOther.body.data);
    expect(mock.connects).toEqual([]);
    expect((await bobBrowser.get<MailAccount[]>('/api/mail/accounts')).body.data.map((a) => a.id)).not.toContain(personal.id);
  });

  it('vérifié — push : une notification ciblée vers un compte n’atteint jamais l’abonnement de l’autre ; chacun filtre selon SES préférences', async () => {
    const keys = () => ({ p256dh: createECDH('prime256v1').generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') });
    const now = Date.now();
    for (const [user, device, endpoint] of [
      [carol.user.id, 'dev-carol', 'https://fcm.googleapis.com/fcm/send/carol-endpoint'],
      [bob.user.id, 'dev-bob', 'https://fcm.googleapis.com/fcm/send/bob-endpoint'],
    ] as const) {
      db.prepare('INSERT OR IGNORE INTO known_devices (user_id, device_hash, label, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(user, device, 'test', now, now);
      saveSubscription({ userId: user, deviceId: device, sessionId: null }, { endpoint, keys: keys() }, null);
    }
    // Carol a refusé les commandes (test précédent) ; Bob les accepte.
    mock.fetchCalls.length = 0;
    await notify({ type: 'order', title: 'Commande privée', body: 'x', userId: carol.user.id, channels: { push: true } });
    await flushNotifications();
    expect(mock.fetchCalls).toEqual([]); // ni Carol (refus) ni Bob (non destinataire)
    await notify({ type: 'payment', title: 'Paiement ciblé', body: 'x', userId: carol.user.id, channels: { push: true } });
    await flushNotifications();
    expect(mock.fetchCalls).toEqual(['https://fcm.googleapis.com/fcm/send/carol-endpoint']);
    mock.fetchCalls.length = 0;
    await notify({ type: 'order', title: 'Commande commune', body: 'x', userId: null, channels: { push: true } });
    await flushNotifications();
    expect(mock.fetchCalls).toEqual(['https://fcm.googleapis.com/fcm/send/bob-endpoint']);
    // La notification ciblée n'apparaît pas dans le centre de Bob.
    const bobNotifs = await bobBrowser.get<PanelNotification[]>('/api/notifications?pageSize=100');
    expect(bobNotifs.body.data.map((n) => n.title)).not.toContain('Paiement ciblé');
  });
});
