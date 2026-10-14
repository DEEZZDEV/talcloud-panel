import type { Cost, SettingsTestResult, SettingsView, WhmcsClient, WhmcsClientDetail, WhmcsInvoice, WhmcsMonthlyStats, WhmcsOrder, WhmcsOverview, WhmcsSettingsValues } from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { Response } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { upstreamFetch } from '../src/core/http.js';
import { getSettings, setSettings } from '../src/core/settings.js';
import { db } from '../src/db/index.js';
import { clearWhmcsCache } from '../src/modules/whmcs/cache.js';
import { fetchAll, whmcsCall } from '../src/modules/whmcs/client.js';
import { costForMonth, costsByMonth } from '../src/modules/whmcs/costs.js';
import { addMonths, currentMonth, dateOnly, dateTimeIso, decodeEntities, extractList, int, monthOf, monthsEndingAt, num, round2, str } from '../src/modules/whmcs/parse.js';
import { findClientByEmail, findClientsByEmails, isWhmcsConfigured } from '../src/modules/whmcs/service.js';
import { advance, Browser, buildTestApp, createTestAdmin, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

// L'API WHMCS est simulée en remplaçant le seul point de sortie HTTP (core/http.ts) ; le reste du module est réel.
vi.mock('../src/core/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/http.js')>();
  return { ...actual, upstreamFetch: vi.fn() };
});

const IDENTIFIER = 'ident-TRES-SECRET-9f3a';
const SECRET = 'secret-TRES-SECRET-77c1';
const ACCESS_KEY = 'cle-acces-TRES-SECRETE-5e2b';
const BASE_URL = 'https://whmcs.exemple.test';

type Row = Record<string, unknown>;

/** Faux WHMCS : pagination par limitstart / limitnum, nombres en chaînes, listes vides en chaîne vide. */
class FakeWhmcs {
  clients: Row[] = [];
  orders: Row[] = [];
  invoices: Row[] = [];
  transactions: Row[] = [];
  products: Row[] = [];
  currencies: Row[] = [];
  calls: { action: string; params: Record<string, string>; url: string; redirect: unknown }[] = [];
  /** Réponse forcée (erreurs, formes bancales). */
  override: ((action: string, params: Record<string, string>) => { status?: number; body: unknown } | undefined) | null = null;
  ignorePagination = false;
  delayMs = 0;

  reset(): void {
    this.clients = [];
    this.orders = [];
    this.invoices = [];
    this.transactions = [];
    this.products = [];
    this.currencies = [
      { id: 1, code: 'EUR', prefix: '', suffix: '€', format: 1, rate: '1.00000' },
      { id: 2, code: 'USD', prefix: '$', suffix: ' USD', format: 1, rate: '1.25000' },
    ];
    this.calls = [];
    this.override = null;
    this.ignorePagination = false;
    this.delayMs = 0;
  }

  count(action: string): number {
    return this.calls.filter((call) => call.action === action).length;
  }

  private paged(rows: Row[], params: Record<string, string>, container: string, item: string): Row {
    const start = this.ignorePagination ? 0 : Number(params.limitstart ?? 0);
    const limit = this.ignorePagination ? rows.length : Number(params.limitnum ?? 25);
    const slice = rows.slice(start, start + limit);
    return {
      result: 'success',
      totalresults: String(rows.length),
      startnumber: start,
      numreturned: slice.length,
      [container]: slice.length === 0 ? '' : { [item]: slice },
    };
  }

  private answer(action: string, p: Record<string, string>): { status?: number; body: unknown } {
    const forced = this.override?.(action, p);
    if (forced) return forced;
    if (p.identifier !== IDENTIFIER || p.secret !== SECRET) return { status: 403, body: { result: 'error', message: 'Authentication Failed' } };
    switch (action) {
      case 'GetCurrencies':
        return { body: { result: 'success', totalresults: this.currencies.length, currencies: { currency: this.currencies } } };
      case 'GetClients': {
        let rows = this.clients;
        if (p.status) rows = rows.filter((c) => c.status === p.status);
        if (p.orderby === 'id' && p.sorting === 'DESC') rows = [...rows].sort((a, b) => Number(b.id) - Number(a.id));
        return { body: this.paged(rows, p, 'clients', 'client') };
      }
      case 'GetClientsDetails': {
        const found = this.clients.find((c) => (p.clientid ? String(c.id) === p.clientid : String(c.email).toLowerCase() === (p.email ?? '').toLowerCase()));
        if (!found) return { body: { result: 'error', message: 'Client Not Found' } };
        const client = { ...found, userid: found.id, fullname: `${String(found.firstname)} ${String(found.lastname)}` };
        // Comme WHMCS : champs à plat ET sous « client ».
        return { body: { result: 'success', ...client, client } };
      }
      case 'GetClientsProducts':
        return { body: this.paged(this.products.filter((s) => String(s.clientid) === p.clientid), p, 'products', 'product') };
      case 'GetOrders': {
        let rows = [...this.orders].sort((a, b) => Number(b.id) - Number(a.id));
        if (p.status) rows = rows.filter((o) => o.status === p.status);
        return { body: this.paged(rows, p, 'orders', 'order') };
      }
      case 'GetInvoices': {
        let rows = [...this.invoices].sort((a, b) => Number(b.id) - Number(a.id));
        if (p.userid) rows = rows.filter((i) => String(i.userid) === p.userid);
        if (p.status === 'Overdue') rows = rows.filter((i) => i.status === 'Unpaid' && String(i.duedate) < '2026-03-01');
        else if (p.status) rows = rows.filter((i) => i.status === p.status);
        return { body: this.paged(rows, p, 'invoices', 'invoice') };
      }
      case 'GetTransactions': {
        const rows = p.clientid ? this.transactions.filter((t) => String(t.userid) === p.clientid) : this.transactions;
        return { body: this.paged(rows, p, 'transactions', 'transaction') };
      }
      default:
        return { body: { result: 'error', message: `Invalid Permissions: API action "${action}" is not allowed` } };
    }
  }

  handle = async (_integration: unknown, url: string | URL, options: { body?: unknown; redirect?: unknown; method?: string; headers?: unknown } = {}) => {
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({ 'content-type': 'application/x-www-form-urlencoded' });
    const params = Object.fromEntries(new URLSearchParams(String(options.body)));
    expect(params.responsetype).toBe('json');
    const action = params.action ?? '';
    this.calls.push({ action, params, url: String(url), redirect: options.redirect });
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const { status = 200, body } = this.answer(action, params);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
}

const whmcs = new FakeWhmcs();

const client = (id: number, extra: Row = {}): Row => ({
  id,
  firstname: `Prénom${id}`,
  lastname: `Nom${id}`,
  companyname: '',
  email: `client${id}@exemple.test`,
  datecreated: '2025-01-15',
  groupid: 0,
  status: 'Active',
  ...extra,
});

const tx = (id: number, date: string, amountin: string, extra: Row = {}): Row => ({
  id,
  userid: 1,
  currency: 0,
  gateway: 'stripe',
  date,
  description: 'Invoice Payment',
  amountin,
  fees: '0.00',
  amountout: '0.00',
  rate: '1.00000',
  transid: `tr_${id}`,
  invoiceid: id,
  refundid: 0,
  ...extra,
});

const order = (id: number, date: string, extra: Row = {}): Row => ({
  id,
  ordernum: String(1000000000 + id),
  userid: 1,
  date,
  amount: '9.99',
  paymentmethod: 'stripe',
  paymentmethodname: 'Carte bancaire',
  invoiceid: String(id + 500),
  status: 'Active',
  paymentstatus: 'Paid',
  name: 'Jean Dupont',
  currencyprefix: '',
  currencysuffix: '€',
  lineitems: { lineitem: [{ type: 'product', relid: 1, producttype: 'Shared Hosting', product: 'Minecraft 4 Go', domain: '', billingcycle: 'Monthly', amount: '9.99€', status: 'Active' }] },
  ...extra,
});

const invoice = (id: number, extra: Row = {}): Row => ({
  id,
  userid: 1,
  firstname: 'Jean',
  lastname: 'Dupont',
  companyname: '',
  invoicenum: '',
  date: '2026-02-10',
  duedate: '2026-02-24',
  datepaid: '0000-00-00 00:00:00',
  total: '10.00',
  status: 'Unpaid',
  paymentmethod: 'stripe',
  currencycode: 'EUR',
  ...extra,
});

function configure(): void {
  setSettings('whmcs', { url: BASE_URL, identifier: IDENTIFIER, secret: SECRET });
  clearWhmcsCache();
}

function unconfigure(): void {
  db.prepare("DELETE FROM integration_settings WHERE namespace = 'whmcs'").run();
  clearWhmcsCache();
}

let app: FastifyInstance;
let admin: TestAdmin;
let browser: Browser;

beforeAll(async () => {
  useFakeClock(); // 2026-03-01 10:00 UTC → mois en cours : 2026-03
  vi.mocked(upstreamFetch).mockImplementation(whmcs.handle as unknown as typeof upstreamFetch);
  app = await buildTestApp();
  admin = await createTestAdmin('whmcs-admin');
  browser = new Browser(app, uniqueIp());
  await browser.login(admin);
});

beforeEach(() => {
  whmcs.reset();
  db.prepare('DELETE FROM costs').run();
  configure();
});

afterAll(async () => {
  await app.close();
});

// ───────────────────────────── Lecture tolérante ─────────────────────────────

describe('parsing des réponses WHMCS', () => {
  it('extractList : listes absentes, chaînes vides, objet unique, tableau, objet à clés numériques', () => {
    expect(extractList({}, 'clients', 'client')).toEqual([]);
    expect(extractList({ clients: '' }, 'clients', 'client')).toEqual([]);
    expect(extractList({ clients: null }, 'clients', 'client')).toEqual([]);
    expect(extractList({ clients: [] }, 'clients', 'client')).toEqual([]);
    expect(extractList({ clients: {} }, 'clients', 'client')).toEqual([]);
    expect(extractList({ clients: { client: '' } }, 'clients', 'client')).toEqual([]);
    expect(extractList({ clients: { client: [] } }, 'clients', 'client')).toEqual([]);
    expect(extractList({ clients: { client: { id: '3' } } }, 'clients', 'client')).toEqual([{ id: '3' }]);
    expect(extractList({ clients: { client: [{ id: 1 }, { id: 2 }] } }, 'clients', 'client')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(extractList({ clients: { client: { 0: { id: 1 }, 2: { id: 2 } } } }, 'clients', 'client')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(extractList({ clients: [{ id: 1 }, 'bruit', null] }, 'clients', 'client')).toEqual([{ id: 1 }]);
    expect(extractList({ clients: { 0: { id: 7 } } }, 'clients', 'client')).toEqual([{ id: 7 }]);
  });

  it('nombres en chaînes, valeurs absurdes, entités HTML', () => {
    expect(num('12.50')).toBe(12.5);
    expect(num(' 7 ')).toBe(7);
    expect(num(3)).toBe(3);
    expect(num('')).toBe(0);
    expect(num('abc')).toBe(0);
    expect(num(null)).toBe(0);
    expect(num('Infinity')).toBe(0);
    expect(int('42')).toBe(42);
    expect(int('-3')).toBe(0);
    expect(int(undefined)).toBe(0);
    expect(str('  ')).toBeNull();
    expect(str('Caf&eacute; &amp; Fils &#039;SARL&#039; &lt;b&gt;')).toBe("Caf&eacute; & Fils 'SARL' <b>");
    expect(decodeEntities('A &#x26; B')).toBe('A & B');
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-0.001)).toBe(0);
    expect(Object.is(round2(-0.001), 0)).toBe(true);
  });

  it('dates : nulles WHMCS, date seule conservée, mois lu sans conversion de fuseau', () => {
    expect(dateOnly('0000-00-00')).toBeNull();
    expect(dateOnly('')).toBeNull();
    expect(dateOnly(undefined)).toBeNull();
    expect(dateOnly('2026-03-05')).toBe('2026-03-05');
    expect(dateOnly('2026-03-05 14:22:10')).toBe('2026-03-05');
    expect(dateTimeIso('0000-00-00 00:00:00')).toBeNull();
    expect(dateTimeIso('2026-03-05')).toBe('2026-03-05');
    expect(dateTimeIso('2026-03-05 14:22:10')).toBe(new Date(2026, 2, 5, 14, 22, 10).toISOString());
    expect(monthOf('2026-02-28 23:59:59')).toBe('2026-02');
    expect(monthOf('2026-03-01 00:00:00')).toBe('2026-03');
    expect(monthOf('2026-13-01')).toBeNull();
    expect(monthOf('n’importe quoi')).toBeNull();
  });

  it('arithmétique des mois', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-12', 1)).toBe('2026-01');
    expect(addMonths('2026-03', -23)).toBe('2024-04');
    expect(monthsEndingAt('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(currentMonth(new Date(2026, 0, 31, 23, 59))).toBe('2026-01');
    expect(currentMonth()).toBe('2026-03');
  });
});

// ───────────────────────────── Client API ─────────────────────────────

describe('client API WHMCS', () => {
  it('poste les identifiants dans le corps vers /includes/api.php, sans suivre les redirections', async () => {
    setSettings('whmcs', { url: BASE_URL, identifier: IDENTIFIER, secret: SECRET, accessKey: ACCESS_KEY });
    whmcs.override = (action) => (action === 'GetClients' ? { body: { result: 'success', totalresults: 0, clients: '' } } : undefined);
    await whmcsCall('GetClients', { limitnum: 1 });
    const call = whmcs.calls[0]!;
    expect(call.url).toBe(`${BASE_URL}/includes/api.php`);
    expect(call.url).not.toContain(SECRET);
    expect(call.redirect).toBe('error');
    expect(call.params).toMatchObject({ identifier: IDENTIFIER, secret: SECRET, accesskey: ACCESS_KEY, action: 'GetClients', responsetype: 'json', limitnum: '1' });
  });

  it('sans clé d’accès, le paramètre accesskey n’est pas envoyé', async () => {
    await whmcsCall('GetCurrencies');
    expect('accesskey' in whmcs.calls[0]!.params).toBe(false);
  });

  it('result: "error" → UPSTREAM_ERROR sobre, sans message brut ni secret', async () => {
    const cases: [string, number, RegExp][] = [
      [`Authentication Failed for ${IDENTIFIER}`, 403, /Identifiants API WHMCS refusés/],
      ['Invalid IP 203.0.113.9', 403, /adresse IP du panel \(203\.0\.113\.9\)/],
      ['Invalid Permissions: API action "getclients" is not allowed', 403, /Permission API WHMCS manquante pour l'action GetClients/],
      [`Erreur SQL près de '${SECRET}' <script>alert(1)</script>`, 200, /WHMCS a renvoyé une erreur pour l'action GetClients/],
    ];
    for (const [message, status, expected] of cases) {
      whmcs.override = () => ({ status, body: { result: 'error', message } });
      const err = await whmcsCall('GetClients').catch((e: unknown) => e as { code: string; statusCode: number; message: string; details: unknown });
      expect(err).toMatchObject({ code: 'UPSTREAM_ERROR', statusCode: 502 });
      const text = JSON.stringify({ message: (err as { message: string }).message, details: (err as { details: unknown }).details });
      expect(text).toMatch(expected);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(IDENTIFIER);
      expect(text).not.toContain('script');
      expect(text).not.toContain('SQL');
    }
  });

  it('statut HTTP en erreur ou corps illisible → UPSTREAM_ERROR', async () => {
    whmcs.override = () => ({ status: 500, body: '<html>Oops</html>' });
    await expect(whmcsCall('GetClients')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', details: { integration: 'whmcs', status: 500 } });
    whmcs.override = () => ({ status: 200, body: '<html>maintenance</html>' });
    await expect(whmcsCall('GetClients')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', message: 'Réponse illisible de whmcs' });
    whmcs.override = () => ({ status: 200, body: '[1,2]' });
    await expect(whmcsCall('GetClients')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('pagination : enchaîne limitstart / limitnum jusqu’à totalresults', async () => {
    whmcs.clients = Array.from({ length: 620 }, (_, i) => client(i + 1));
    const all = await fetchAll('GetClients', {}, 'clients', 'client');
    expect(all).toMatchObject({ total: 620, truncated: false });
    expect(all.items.length).toBe(620);
    expect(new Set(all.items.map((c) => c.id)).size).toBe(620);
    expect(whmcs.calls.map((c) => [c.params.limitstart, c.params.limitnum])).toEqual([
      ['0', '250'],
      ['250', '250'],
      ['500', '250'],
    ]);
  });

  it('pagination : plafond de pages atteint → tronqué ; aucun résultat → liste vide', async () => {
    whmcs.clients = Array.from({ length: 30 }, (_, i) => client(i + 1));
    const capped = await fetchAll('GetClients', {}, 'clients', 'client', { pageSize: 10, maxPages: 2 });
    expect(capped.items.length).toBe(20);
    expect(capped).toMatchObject({ total: 30, truncated: true });
    expect(whmcs.calls.length).toBe(2);

    whmcs.clients = [];
    expect(await fetchAll('GetClients', {}, 'clients', 'client')).toEqual({ items: [], total: 0, truncated: false });
  });

  it('pagination ignorée par le serveur : pas de doublon ni de boucle', async () => {
    whmcs.transactions = Array.from({ length: 700 }, (_, i) => tx(i + 1, '2026-03-01 08:00:00', '1.00'));
    whmcs.ignorePagination = true;
    const all = await fetchAll('GetTransactions', {}, 'transactions', 'transaction');
    expect(all.items.length).toBe(700);
    expect(whmcs.calls.length).toBe(1);

    // Sans totalresults et avec une page pleine renvoyée en boucle : arrêt au deuxième tour.
    whmcs.calls = [];
    const page = Array.from({ length: 5 }, (_, i) => tx(i + 1, '2026-03-01 08:00:00', '1.00'));
    whmcs.override = () => ({ body: { result: 'success', transactions: { transaction: page } } });
    const looped = await fetchAll('GetTransactions', {}, 'transactions', 'transaction', { pageSize: 5 });
    expect(looped.items.length).toBe(5);
    expect(whmcs.calls.length).toBe(2);
  });

  it('résultat unique renvoyé comme objet, et serveur qui plafonne limitnum', async () => {
    whmcs.override = () => ({ body: { result: 'success', totalresults: '1', clients: { client: client(9) } } });
    expect((await fetchAll('GetClients', {}, 'clients', 'client')).items.map((c) => c.id)).toEqual([9]);

    // Le serveur ne renvoie que 100 lignes par page malgré limitnum=250 : on avance des lignes réellement reçues.
    const rows = Array.from({ length: 230 }, (_, i) => client(i + 1));
    whmcs.calls = [];
    whmcs.override = (_action, p) => {
      const start = Number(p.limitstart);
      return { body: { result: 'success', totalresults: '230', clients: { client: rows.slice(start, start + 100) } } };
    };
    const all = await fetchAll('GetClients', {}, 'clients', 'client');
    expect(all.items.length).toBe(230);
    expect(whmcs.calls.map((c) => c.params.limitstart)).toEqual(['0', '100', '200']);
  });
});

// ───────────────────────────── Coûts ─────────────────────────────

describe('imputation des coûts', () => {
  const base = { amount: 120, startMonth: '2025-11', endMonth: '2026-02' as string | null };

  it('monthly : chaque mois de startMonth à endMonth inclus', () => {
    const cost = { ...base, recurrence: 'monthly' as const };
    expect(['2025-10', '2025-11', '2025-12', '2026-02', '2026-03'].map((m) => costForMonth(cost, m))).toEqual([0, 120, 120, 120, 0]);
    expect(costForMonth({ ...cost, endMonth: null }, '2031-07')).toBe(120);
  });

  it('yearly : 1/12 par mois sur la période', () => {
    const cost = { ...base, recurrence: 'yearly' as const };
    expect(['2025-10', '2025-11', '2026-02', '2026-03'].map((m) => costForMonth(cost, m))).toEqual([0, 10, 10, 0]);
    expect(costForMonth({ ...cost, amount: 100, endMonth: null }, '2030-01')).toBeCloseTo(8.3333, 4);
  });

  it('one_time : uniquement sur startMonth', () => {
    const cost = { ...base, recurrence: 'one_time' as const, endMonth: null };
    expect(['2025-10', '2025-11', '2025-12'].map((m) => costForMonth(cost, m))).toEqual([0, 120, 0]);
  });

  it('somme par mois', () => {
    const costs = [
      { id: 1, label: 'a', category: 'servers', notes: null, createdAt: '', amount: 50, recurrence: 'monthly', startMonth: '2026-01', endMonth: null },
      { id: 2, label: 'b', category: 'licenses', notes: null, createdAt: '', amount: 120, recurrence: 'yearly', startMonth: '2026-02', endMonth: null },
      { id: 3, label: 'c', category: 'other', notes: null, createdAt: '', amount: 30, recurrence: 'one_time', startMonth: '2026-02', endMonth: null },
    ] satisfies Cost[];
    expect([...costsByMonth(['2025-12', '2026-01', '2026-02', '2026-03'], costs)]).toEqual([
      ['2025-12', 0],
      ['2026-01', 50],
      ['2026-02', 90],
      ['2026-03', 60],
    ]);
  });
});

describe('routes /api/whmcs/costs', () => {
  const valid = { label: '  Serveur dédié OVH ', category: 'servers', amount: 89.99, recurrence: 'monthly', startMonth: '2026-01', endMonth: null, notes: '' };

  it('fonctionnent sans WHMCS : création, lecture, modification, suppression, journalisées', async () => {
    unconfigure();
    expect((await browser.get<Cost[]>('/api/whmcs/costs')).body.data).toEqual([]);

    const created = await browser.post<Cost>('/api/whmcs/costs', valid);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ label: 'Serveur dédié OVH', category: 'servers', amount: 89.99, recurrence: 'monthly', startMonth: '2026-01', endMonth: null, notes: null });
    expect(Object.keys(created.body.data).sort()).toEqual(['amount', 'category', 'createdAt', 'endMonth', 'id', 'label', 'notes', 'recurrence', 'startMonth']);
    expect(created.body.data.createdAt).toBe(new Date(Date.now()).toISOString());
    const id = created.body.data.id;

    const updated = await browser.put<Cost>(`/api/whmcs/costs/${id}`, { ...valid, amount: 99, endMonth: '2026-06', notes: 'renégocié' });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ id, amount: 99, endMonth: '2026-06', notes: 'renégocié' });
    expect((await browser.get<Cost[]>('/api/whmcs/costs')).body.data).toEqual([updated.body.data]);

    expect((await browser.delete(`/api/whmcs/costs/${id}`)).status).toBe(200);
    expect((await browser.get<Cost[]>('/api/whmcs/costs')).body.data).toEqual([]);
    expect((await browser.delete(`/api/whmcs/costs/${id}`)).status).toBe(404);
    expect((await browser.put(`/api/whmcs/costs/${id}`, valid)).status).toBe(404);

    const log = db.prepare("SELECT action, target, success, user_id FROM audit_log WHERE action LIKE 'whmcs.cost.%' ORDER BY id").all() as { action: string; target: string; success: number; user_id: number }[];
    expect(log.map((row) => [row.action, row.success])).toEqual([
      ['whmcs.cost.create', 1],
      ['whmcs.cost.update', 1],
      ['whmcs.cost.delete', 1],
      ['whmcs.cost.delete', 0],
      ['whmcs.cost.update', 0],
    ]);
    expect(log[0]!.target).toBe(`coût #${id} (Serveur dédié OVH)`);
    expect(log.every((row) => row.user_id === admin.user.id)).toBe(true);
  });

  it('validation stricte des entrées', async () => {
    const invalid: Record<string, unknown>[] = [
      { ...valid, startMonth: '2026-13' },
      { ...valid, startMonth: '2026-1' },
      { ...valid, startMonth: '26-01' },
      { ...valid, startMonth: '2026-01-01' },
      { ...valid, endMonth: '2025-12' },
      { ...valid, endMonth: 'bientôt' },
      { ...valid, amount: -1 },
      { ...valid, amount: '12' },
      { ...valid, amount: 1.234 },
      { ...valid, amount: 1e12 },
      { ...valid, category: 'pots-de-vin' },
      { ...valid, recurrence: 'weekly' },
      { ...valid, label: '   ' },
      { ...valid, label: 'x'.repeat(121) },
      { ...valid, id: 99 },
      { ...valid, createdAt: '2020-01-01T00:00:00Z' },
      { label: 'incomplet' },
      {},
    ];
    for (const body of invalid) {
      const res = await browser.post('/api/whmcs/costs', body);
      expect([JSON.stringify(body), res.status, res.errorCode]).toEqual([JSON.stringify(body), 400, 'VALIDATION_ERROR']);
    }
    expect((await browser.get<Cost[]>('/api/whmcs/costs')).body.data).toEqual([]);

    // Bornes acceptées : montant nul, fin égale au début, fin omise.
    expect((await browser.post('/api/whmcs/costs', { ...valid, amount: 0, endMonth: '2026-01' })).status).toBe(201);
    const { endMonth: _omitted, ...withoutEnd } = valid;
    expect((await browser.post<Cost>('/api/whmcs/costs', withoutEnd)).body.data.endMonth).toBeNull();
    // Dépense ponctuelle : le mois de fin n'a pas de sens, il n'est pas conservé.
    const oneTime = await browser.post<Cost>('/api/whmcs/costs', { ...valid, recurrence: 'one_time', endMonth: '2026-05' });
    expect(oneTime.body.data.endMonth).toBeNull();

    for (const id of ['abc', '0', '-1', '1.5', '99999999999', '1;DROP TABLE costs']) {
      expect((await browser.put(`/api/whmcs/costs/${encodeURIComponent(id)}`, valid)).status).toBe(400);
      expect((await browser.delete(`/api/whmcs/costs/${encodeURIComponent(id)}`)).status).toBe(400);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM costs').get() as { n: number }).n).toBe(3);
  });

  it('exigent une session et le jeton CSRF', async () => {
    const anonymous = new Browser(app, uniqueIp());
    expect((await anonymous.get('/api/whmcs/costs')).status).toBe(401);
    expect((await anonymous.get('/api/whmcs/stats/overview')).status).toBe(401);
    expect((await anonymous.get('/api/whmcs/clients')).status).toBe(401);
    expect((await browser.post('/api/whmcs/costs', valid, { csrf: null })).status).toBe(403);
    expect((await browser.post('/api/whmcs/costs', valid, { origin: 'https://attaquant.test' })).status).toBe(403);
    expect((await browser.get<Cost[]>('/api/whmcs/costs')).body.data).toEqual([]);
  });
});

// ───────────────────────────── Statistiques ─────────────────────────────

describe('statistiques', () => {
  function seed(): void {
    whmcs.clients = [
      client(1, { datecreated: '2025-06-10' }),
      client(2, { datecreated: '2026-01-31' }),
      client(3, { datecreated: '2026-02-01' }),
      client(4, { datecreated: '2026-02-28', status: 'Inactive' }),
      client(5, { datecreated: '2026-03-01' }),
      client(6, { datecreated: '0000-00-00', status: 'Closed' }),
    ];
    whmcs.transactions = [
      tx(1, '2026-01-31 23:59:59', '100.00', { fees: '3.00' }),
      tx(2, '2026-02-01 00:00:00', '200.00', { fees: '6.20' }),
      tx(3, '2026-02-15 12:00:00', '50.10'),
      tx(4, '2026-02-28 23:59:59', '0.20'),
      // Remboursement : amountout, frais restitués (négatifs).
      tx(5, '2026-02-20 09:00:00', '0.00', { amountout: '30.00', fees: '-1.20' }),
      // Paiement en USD au taux 1.25 → 125 / 1.25 = 100 EUR, frais 5 / 1.25 = 4 EUR.
      tx(6, '2026-03-01 00:00:00', '125.00', { fees: '5.00', rate: '1.25000' }),
      tx(7, '2026-03-01 09:30:00', '40.00', { rate: '0.00000' }), // taux absent → 1
      tx(8, '0000-00-00 00:00:00', '999.00'), // date invalide : ignorée
    ];
    whmcs.orders = [
      order(1, '2025-12-31 23:59:59'),
      order(2, '2026-01-01 00:00:00'),
      order(3, '2026-02-10 10:00:00'),
      order(4, '2026-02-11 10:00:00', { status: 'Cancelled' }),
      order(5, '2026-02-28 23:59:59', { status: 'Pending' }),
      order(6, '2026-03-01 00:00:00'),
    ];
    whmcs.invoices = [
      invoice(1, { total: '10.00' }),
      invoice(2, { total: '25.00', currencycode: 'USD' }), // 25 / 1.25 = 20 EUR
      invoice(3, { total: '99.00', status: 'Paid' }),
      invoice(4, { total: '5.55', duedate: '2026-04-01' }),
    ];
  }

  async function addCosts(): Promise<void> {
    const post = (body: Record<string, unknown>) => browser.post('/api/whmcs/costs', { category: 'servers', notes: null, endMonth: null, ...body });
    expect((await post({ label: 'Dédié', amount: 60, recurrence: 'monthly', startMonth: '2026-02' })).status).toBe(201);
    expect((await post({ label: 'Ancien dédié', amount: 40, recurrence: 'monthly', startMonth: '2025-10', endMonth: '2026-01' })).status).toBe(201);
    expect((await post({ label: 'Licence', amount: 100, recurrence: 'yearly', startMonth: '2026-01', category: 'licenses' })).status).toBe(201);
    expect((await post({ label: 'Disque', amount: 33.33, recurrence: 'one_time', startMonth: '2026-02', category: 'other' })).status).toBe(201);
  }

  it('série mensuelle : encaissements, remboursements, frais, coûts des trois récurrences, bornes de mois', async () => {
    seed();
    await addCosts();
    const res = await browser.get<WhmcsMonthlyStats & { truncated: boolean }>('/api/whmcs/stats/monthly?months=4');
    expect(res.status).toBe(200);
    expect(res.body.data.currency).toBe('EUR');
    expect(res.body.data.truncated).toBe(false);
    expect(res.body.data.points).toEqual([
      // Décembre : aucune transaction ; coût mensuel terminé fin janvier (40).
      { month: '2025-12', revenue: 0, costs: 40, profit: -40, newClients: 0, orders: 1 },
      // Janvier : 100 encaissés ; coûts 40 + 100/12 + frais 3 = 51,33.
      { month: '2026-01', revenue: 100, costs: 51.33, profit: 48.67, newClients: 1, orders: 1 },
      // Février : 200 + 50,10 + 0,20 − 30 = 220,30 ; coûts 60 + 8,3333 + 33,33 + frais (6,20 − 1,20) = 106,66.
      { month: '2026-02', revenue: 220.3, costs: 106.66, profit: 113.64, newClients: 2, orders: 3 },
      // Mars : 125/1,25 + 40 = 140 ; coûts 60 + 8,3333 + frais 5/1,25 = 72,33.
      { month: '2026-03', revenue: 140, costs: 72.33, profit: 67.67, newClients: 1, orders: 1 },
    ]);
  });

  it('months : 12 par défaut, bornes 1–24, mois sans donnée à zéro, du plus ancien au plus récent', async () => {
    seed();
    const twelve = await browser.get<WhmcsMonthlyStats>('/api/whmcs/stats/monthly');
    expect(twelve.body.data.points.map((p) => p.month)).toEqual(monthsEndingAt('2026-03', 12));
    expect(twelve.body.data.points[0]).toEqual({ month: '2025-04', revenue: 0, costs: 0, profit: 0, newClients: 0, orders: 0 });
    expect(twelve.body.data.points.find((p) => p.month === '2025-06')!.newClients).toBe(1);

    const one = await browser.get<WhmcsMonthlyStats>('/api/whmcs/stats/monthly?months=1');
    expect(one.body.data.points.map((p) => p.month)).toEqual(['2026-03']);
    expect((await browser.get<WhmcsMonthlyStats>('/api/whmcs/stats/monthly?months=24')).body.data.points.length).toBe(24);
    for (const bad of ['0', '25', '-1', 'abc', '1.5']) {
      expect((await browser.get(`/api/whmcs/stats/monthly?months=${bad}`)).status).toBe(400);
    }
  });

  it('vue d’ensemble : mois en cours, impayés, clients actifs, variations', async () => {
    seed();
    await addCosts();
    const res = await browser.get<WhmcsOverview & { truncated: boolean }>('/api/whmcs/stats/overview');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      currency: 'EUR',
      month: '2026-03',
      revenue: 140,
      costs: 72.33,
      netProfit: 67.67,
      newClients: 1,
      orders: 1,
      // 10 + 25/1,25 + 5,55 (la facture payée est exclue).
      unpaidInvoices: { count: 3, total: 35.55 },
      activeClients: 4,
      deltas: {
        revenue: -36.5, // (140 − 220,30) / 220,30
        netProfit: -40.5, // (67,67 − 113,64) / 113,64
        newClients: -50,
        orders: -66.7,
      },
      truncated: false,
    });
  });

  it('variations non calculables (mois précédent à zéro) → null ; WHMCS vide → zéros', async () => {
    const res = await browser.get<WhmcsOverview>('/api/whmcs/stats/overview');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      revenue: 0,
      costs: 0,
      netProfit: 0,
      newClients: 0,
      orders: 0,
      unpaidInvoices: { count: 0, total: 0 },
      activeClients: 0,
      deltas: { revenue: null, netProfit: null, newClients: null, orders: null },
    });
  });

  it('les commandes ne sont lues que jusqu’au début de la période', async () => {
    // 600 commandes anciennes puis 3 récentes : sur les 3 pages existantes, seules les 2 premières sont lues.
    whmcs.orders = [...Array.from({ length: 600 }, (_, i) => order(i + 1, '2024-05-05 10:00:00')), order(601, '2026-02-03 10:00:00'), order(602, '2026-03-01 08:00:00'), order(603, '2026-03-01 09:00:00')];
    const res = await browser.get<WhmcsOverview>('/api/whmcs/stats/overview');
    expect(res.body.data.orders).toBe(2);
    expect(res.body.data.deltas.orders).toBe(100);
    expect(whmcs.count('GetOrders')).toBe(2); // la 2e page, entièrement antérieure à la période, arrête la lecture
  });

  it('cache : 5 minutes, une seule requête en vol par clé, vidé par un changement de réglages', async () => {
    seed();
    whmcs.delayMs = 5;
    const [a, b, c] = await Promise.all([
      browser.get<WhmcsOverview>('/api/whmcs/stats/overview'),
      browser.get<WhmcsOverview>('/api/whmcs/stats/overview'),
      browser.get<WhmcsMonthlyStats>('/api/whmcs/stats/monthly?months=2'),
    ]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(a.body.data).toEqual(b.body.data);
    expect(whmcs.count('GetTransactions')).toBe(1);
    expect(whmcs.count('GetCurrencies')).toBe(1);
    expect(whmcs.count('GetOrders')).toBe(1);
    expect(whmcs.count('GetInvoices')).toBe(1);
    // GetClients : annuaire (1) + décompte des clients actifs (1).
    expect(whmcs.count('GetClients')).toBe(2);

    const before = whmcs.calls.length;
    await browser.get('/api/whmcs/stats/overview');
    expect(whmcs.calls.length).toBe(before);

    // Un coût saisi est pris en compte tout de suite, sans nouvelle requête vers WHMCS.
    await browser.post('/api/whmcs/costs', { label: 'x', category: 'other', amount: 10, recurrence: 'one_time', startMonth: '2026-03', endMonth: null, notes: null });
    expect((await browser.get<WhmcsOverview>('/api/whmcs/stats/overview')).body.data.costs).toBe(a.body.data.costs + 10);
    expect(whmcs.calls.length).toBe(before);

    advance(5 * 60_000 + 1);
    await browser.get('/api/whmcs/stats/overview');
    expect(whmcs.count('GetTransactions')).toBe(2);

    // Enregistrer les réglages vide le cache.
    expect((await browser.stepUp(admin)).status).toBe(200);
    expect((await browser.put('/api/settings/whmcs', { url: BASE_URL })).status).toBe(200);
    await browser.get('/api/whmcs/stats/overview');
    expect(whmcs.count('GetTransactions')).toBe(3);
  });

  it('erreur WHMCS → 502 sobre, mémorisée 10 s pour ne pas marteler un WHMCS en panne', async () => {
    whmcs.override = () => ({ status: 403, body: { result: 'error', message: `Authentication Failed ${SECRET}` } });
    const res = await browser.get('/api/whmcs/stats/overview');
    expect(res.status).toBe(502);
    expect(res.errorCode).toBe('UPSTREAM_ERROR');
    expect(res.raw.body).not.toContain(SECRET);
    expect(res.raw.body).not.toContain(IDENTIFIER);
    const calls = whmcs.calls.length;
    expect((await browser.get('/api/whmcs/stats/overview')).status).toBe(502);
    expect(whmcs.calls.length).toBe(calls);

    whmcs.override = null;
    advance(10_001);
    expect((await browser.get('/api/whmcs/stats/overview')).status).toBe(200);
  });
});

// ───────────────────────────── Listes et fiche client ─────────────────────────────

describe('clients, commandes, factures', () => {
  it('clients : pagination par WHMCS, filtre de statut, forme du contrat', async () => {
    whmcs.clients = Array.from({ length: 60 }, (_, i) => client(i + 1, i % 3 === 0 ? { status: 'Inactive' } : {}));
    const res = await browser.get<WhmcsClient[]>('/api/whmcs/clients?page=2&pageSize=25');
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 2, pageSize: 25, total: 60 });
    expect(res.body.data.map((c) => c.id)).toEqual(Array.from({ length: 25 }, (_, i) => 35 - i));
    expect(res.body.data[0]).toEqual({ id: 35, name: 'Prénom35 Nom35', email: 'client35@exemple.test', companyName: null, status: 'Active', createdAt: '2025-01-15', country: null, phone: null });
    expect(whmcs.calls.at(-1)!.params).toMatchObject({ limitstart: '25', limitnum: '25' });

    const inactive = await browser.get<WhmcsClient[]>('/api/whmcs/clients?status=inactive&pageSize=100');
    expect(inactive.body.meta).toEqual({ page: 1, pageSize: 100, total: 20 });
    expect(inactive.body.data.every((c) => c.status === 'Inactive')).toBe(true);
    expect(whmcs.calls.at(-1)!.params.status).toBe('Inactive');

    // Statut vide = absent ; au-delà de la dernière page : liste vide.
    expect((await browser.get<WhmcsClient[]>('/api/whmcs/clients?status=')).body.meta).toMatchObject({ total: 60 });
    expect((await browser.get<WhmcsClient[]>('/api/whmcs/clients?page=9')).body.data).toEqual([]);
  });

  it('clients : recherche par sous-chaîne, insensible à la casse, dans l’annuaire', async () => {
    whmcs.clients = [
      client(1, { firstname: 'Élodie', lastname: 'Martin', email: 'elodie@exemple.test' }),
      client(2, { firstname: 'Paul', lastname: 'Durand', companyname: 'Martin &amp; Fils', email: 'paul@durand.test', status: 'Closed' }),
      client(3, { firstname: 'Zoé', lastname: 'Petit', email: 'zoe@exemple.test' }),
    ];
    const found = await browser.get<WhmcsClient[]>('/api/whmcs/clients?search=MARTIN');
    expect(found.body.meta).toEqual({ page: 1, pageSize: 25, total: 2 });
    expect(found.body.data.map((c) => c.id)).toEqual([2, 1]);
    expect(found.body.data[0]!.companyName).toBe('Martin & Fils');
    expect((await browser.get<WhmcsClient[]>('/api/whmcs/clients?search=martin&status=Closed')).body.data.map((c) => c.id)).toEqual([2]);
    expect((await browser.get<WhmcsClient[]>('/api/whmcs/clients?search=durand.test')).body.data.map((c) => c.id)).toEqual([2]);
    expect((await browser.get<WhmcsClient[]>('/api/whmcs/clients?search=introuvable')).body).toMatchObject({ data: [], meta: { total: 0 } });
    // Toutes ces recherches n'ont lu l'annuaire qu'une fois.
    expect(whmcs.count('GetClients')).toBe(1);
  });

  it('paramètres de liste invalides → 400', async () => {
    for (const url of [
      '/api/whmcs/clients?page=0',
      '/api/whmcs/clients?pageSize=101',
      '/api/whmcs/clients?pageSize=abc',
      '/api/whmcs/clients?status=Banni',
      `/api/whmcs/clients?search=${'x'.repeat(101)}`,
      '/api/whmcs/clients?search=a&search=b',
      '/api/whmcs/orders?status=Paid',
      '/api/whmcs/invoices?status=Active',
      '/api/whmcs/clients/abc',
      '/api/whmcs/clients/0',
      '/api/whmcs/clients/1%20OR%201=1',
    ]) {
      const res = await browser.get(url);
      expect([url, res.status]).toEqual([url, 400]);
    }
    expect(whmcs.calls.length).toBe(0);
  });

  it('commandes : forme du contrat, devise retrouvée par préfixe / suffixe, lignes en objet unique', async () => {
    whmcs.orders = [
      order(1, '2026-02-10 10:00:00'),
      order(2, '2026-02-11 11:30:00', {
        status: 'Pending',
        paymentstatus: 'Unpaid',
        invoiceid: '0',
        name: 'Ana Silva',
        currencyprefix: '$',
        currencysuffix: ' USD',
        amount: '15.5',
        lineitems: { lineitem: { product: 'VPS &amp; Sauvegarde' } },
      }),
      order(3, '2026-02-12 08:00:00', { lineitems: '', paymentmethodname: '', paymentstatus: '' }),
    ];
    const res = await browser.get<WhmcsOrder[]>('/api/whmcs/orders');
    expect(res.body.meta).toEqual({ page: 1, pageSize: 25, total: 3 });
    expect(res.body.data.map((o) => o.id)).toEqual([3, 2, 1]);
    expect(res.body.data[1]).toEqual({
      id: 2,
      orderNumber: '1000000002',
      clientId: 1,
      clientName: 'Ana Silva',
      date: new Date(2026, 1, 11, 11, 30, 0).toISOString(),
      amount: 15.5,
      currency: 'USD',
      status: 'Pending',
      paymentStatus: 'Unpaid',
      paymentMethod: 'Carte bancaire',
      products: ['VPS & Sauvegarde'],
      invoiceId: null,
    });
    expect(res.body.data[0]).toMatchObject({ products: [], paymentMethod: 'stripe', paymentStatus: null, currency: 'EUR', invoiceId: 503 });

    expect((await browser.get<WhmcsOrder[]>('/api/whmcs/orders?status=pending')).body.data.map((o) => o.id)).toEqual([2]);
    expect((await browser.get<WhmcsOrder[]>('/api/whmcs/orders?search=silva')).body.data.map((o) => o.id)).toEqual([2]);
    expect((await browser.get<WhmcsOrder[]>('/api/whmcs/orders?search=sauvegarde')).body.data.map((o) => o.id)).toEqual([2]);
    expect((await browser.get<WhmcsOrder[]>('/api/whmcs/orders?search=1000000003')).body.data.map((o) => o.id)).toEqual([3]);
  });

  it('recherche de commandes : limitée aux 1000 plus récentes, signalée par meta.truncated', async () => {
    whmcs.orders = Array.from({ length: 1005 }, (_, i) => order(i + 1, '2026-02-10 10:00:00', { name: i === 0 ? 'Très Ancien' : i === 1004 ? 'Tout Récent' : 'Jean Dupont' }));
    const recent = await browser.get<WhmcsOrder[]>('/api/whmcs/orders?search=récent');
    expect(recent.body.data.map((o) => o.id)).toEqual([1005]);
    expect(recent.body.meta).toEqual({ page: 1, pageSize: 25, total: 1, truncated: true });
    expect((await browser.get<WhmcsOrder[]>('/api/whmcs/orders?search=ancien')).body.data).toEqual([]);
    expect(whmcs.count('GetOrders')).toBe(4);
    // Sans recherche, la pagination de WHMCS donne accès à tout.
    const last = await browser.get<WhmcsOrder[]>('/api/whmcs/orders?page=11&pageSize=100');
    expect(last.body.meta).toEqual({ page: 11, pageSize: 100, total: 1005 });
    expect(last.body.data.map((o) => o.id)).toEqual([5, 4, 3, 2, 1]);
  });

  it('factures : statut « Overdue » déduit de l’échéance, dates nulles, recherche', async () => {
    whmcs.invoices = [
      invoice(1, { duedate: '2026-02-24' }), // échue (nous sommes le 2026-03-01)
      invoice(2, { duedate: '2026-03-15', firstname: 'Ana', lastname: 'Silva', invoicenum: 'FA-2026-0002', total: '1234.5', currencycode: 'USD' }),
      invoice(3, { status: 'Paid', datepaid: '2026-02-12 09:15:00' }),
    ];
    const res = await browser.get<WhmcsInvoice[]>('/api/whmcs/invoices');
    expect(res.body.meta).toEqual({ page: 1, pageSize: 25, total: 3 });
    expect(res.body.data).toEqual([
      { id: 3, clientId: 1, clientName: 'Jean Dupont', date: '2026-02-10', dueDate: '2026-02-24', datePaid: new Date(2026, 1, 12, 9, 15, 0).toISOString(), total: 10, currency: 'EUR', status: 'Paid', paymentMethod: 'stripe' },
      { id: 2, clientId: 1, clientName: 'Ana Silva', date: '2026-02-10', dueDate: '2026-03-15', datePaid: null, total: 1234.5, currency: 'USD', status: 'Unpaid', paymentMethod: 'stripe' },
      { id: 1, clientId: 1, clientName: 'Jean Dupont', date: '2026-02-10', dueDate: '2026-02-24', datePaid: null, total: 10, currency: 'EUR', status: 'Overdue', paymentMethod: 'stripe' },
    ]);
    expect((await browser.get<WhmcsInvoice[]>('/api/whmcs/invoices?status=overdue')).body.data.map((i) => [i.id, i.status])).toEqual([[1, 'Overdue']]);
    expect((await browser.get<WhmcsInvoice[]>('/api/whmcs/invoices?status=Unpaid')).body.meta).toMatchObject({ total: 2 });
    expect((await browser.get<WhmcsInvoice[]>('/api/whmcs/invoices?search=fa-2026')).body.data.map((i) => i.id)).toEqual([2]);
    expect((await browser.get<WhmcsInvoice[]>('/api/whmcs/invoices?search=dupont&status=Paid')).body.data.map((i) => i.id)).toEqual([3]);
  });

  it('listes : cache de 60 s par page', async () => {
    whmcs.orders = [order(1, '2026-02-10 10:00:00')];
    await browser.get('/api/whmcs/orders');
    await browser.get('/api/whmcs/orders');
    expect(whmcs.count('GetOrders')).toBe(1);
    await browser.get('/api/whmcs/orders?page=2');
    expect(whmcs.count('GetOrders')).toBe(2);
    advance(60_001);
    await browser.get('/api/whmcs/orders');
    expect(whmcs.count('GetOrders')).toBe(3);
  });

  it('fiche client : détails, services, factures récentes, totaux', async () => {
    whmcs.clients = [
      client(7, {
        firstname: 'Ana',
        lastname: 'Silva',
        companyname: 'Silva &amp; Co',
        email: 'Ana@Silva.test',
        address1: '12 rue des Lilas',
        address2: '',
        city: 'Lyon',
        state: 'Rhône',
        postcode: '69003',
        countrycode: 'FR',
        countryname: 'France',
        phonenumber: '0601020304',
        credit: '4.50',
        currency: 2,
        currency_code: 'USD',
        datecreated: '2025-09-02',
      }),
    ];
    whmcs.products = [
      { id: 21, clientid: 7, name: 'Minecraft 4 Go', translated_name: 'Minecraft 4 Go', domain: 'mc.silva.test', status: 'Active', billingcycle: 'Monthly', nextduedate: '2026-03-21', recurringamount: '9.99' },
      { id: 22, clientid: 7, name: 'VPS S', domain: '', status: 'Terminated', billingcycle: 'Monthly', nextduedate: '0000-00-00', recurringamount: '5.00' },
      { id: 23, clientid: 8, name: 'Autre client', status: 'Active', recurringamount: '1.00' },
    ];
    whmcs.invoices = [
      ...Array.from({ length: 12 }, (_, i) => invoice(100 + i, { userid: 7, status: 'Paid', total: '9.99', currencycode: 'USD', datepaid: '2026-01-05 10:00:00' })),
      invoice(200, { userid: 7, total: '20.00', currencycode: 'USD', duedate: '2026-02-01' }),
      invoice(201, { userid: 7, total: '7.25', currencycode: 'USD', duedate: '2026-04-01' }),
      invoice(300, { userid: 8, total: '500.00' }),
    ];
    whmcs.transactions = [
      tx(1, '2026-01-05 10:00:00', '119.88', { userid: 7 }),
      tx(2, '2026-01-20 10:00:00', '0.00', { userid: 7, amountout: '9.99' }),
      tx(3, '2026-01-20 10:00:00', '777.00', { userid: 8 }),
    ];

    const res = await browser.get<WhmcsClientDetail>('/api/whmcs/clients/7');
    expect(res.status).toBe(200);
    const detail = res.body.data;
    expect(detail).toMatchObject({
      id: 7,
      name: 'Ana Silva',
      email: 'Ana@Silva.test',
      companyName: 'Silva & Co',
      status: 'Active',
      createdAt: '2025-09-02',
      country: 'FR',
      phone: '0601020304',
      address: '12 rue des Lilas, 69003 Lyon, Rhône, France',
      credit: 4.5,
      currency: 'USD',
      stats: { totalPaid: 109.89, unpaidTotal: 27.25, activeServices: 1 },
      adminUrl: `${BASE_URL}/admin/clientssummary.php?userid=7`,
    });
    expect(detail.services).toEqual([
      { id: 21, name: 'Minecraft 4 Go', domain: 'mc.silva.test', status: 'Active', amount: 9.99, billingCycle: 'Monthly', nextDueDate: '2026-03-21' },
      { id: 22, name: 'VPS S', domain: null, status: 'Terminated', amount: 5, billingCycle: 'Monthly', nextDueDate: null },
    ]);
    expect(detail.recentInvoices.length).toBe(10);
    expect(detail.recentInvoices.slice(0, 2).map((i) => [i.id, i.status, i.currency])).toEqual([
      [201, 'Unpaid', 'USD'],
      [200, 'Overdue', 'USD'],
    ]);
    expect(detail.recentInvoices.every((i) => i.clientId === 7)).toBe(true);
    expect(Object.keys(detail).sort()).toEqual(
      ['address', 'adminUrl', 'companyName', 'country', 'createdAt', 'credit', 'currency', 'email', 'id', 'name', 'phone', 'recentInvoices', 'services', 'stats', 'status'].sort(),
    );
  });

  it('fiche client : sans service ni facture ; client inconnu → 404', async () => {
    whmcs.clients = [client(3)];
    const res = await browser.get<WhmcsClientDetail>('/api/whmcs/clients/3');
    expect(res.body.data).toMatchObject({ id: 3, address: null, credit: 0, currency: 'EUR', services: [], recentInvoices: [], stats: { totalPaid: 0, unpaidTotal: 0, activeServices: 0 } });
    const missing = await browser.get('/api/whmcs/clients/999');
    expect(missing.status).toBe(404);
    expect(missing.errorCode).toBe('NOT_FOUND');
  });
});

// ───────────────────────────── Non configuré ─────────────────────────────

describe('WHMCS non configuré', () => {
  it('409 INTEGRATION_NOT_CONFIGURED sur les routes qui en dépendent, sans appel sortant', async () => {
    unconfigure();
    for (const url of ['/api/whmcs/stats/overview', '/api/whmcs/stats/monthly', '/api/whmcs/clients', '/api/whmcs/clients?search=a', '/api/whmcs/clients/1', '/api/whmcs/orders', '/api/whmcs/invoices']) {
      const res = await browser.get(url);
      expect([url, res.status, res.errorCode]).toEqual([url, 409, 'INTEGRATION_NOT_CONFIGURED']);
      expect(res.body.error!.details).toEqual({ integration: 'whmcs' });
    }
    expect((await browser.get('/api/whmcs/costs')).status).toBe(200);
    expect(whmcs.calls.length).toBe(0);
  });

  it('réglages incomplets (secret manquant) = non configuré', async () => {
    setSettings('whmcs', { url: BASE_URL, identifier: IDENTIFIER });
    clearWhmcsCache();
    expect(isWhmcsConfigured()).toBe(false);
    expect((await browser.get('/api/whmcs/orders')).status).toBe(409);
  });
});

// ───────────────────────────── Réglages ─────────────────────────────

describe('réglages /api/settings/whmcs', () => {
  type View = SettingsView<WhmcsSettingsValues>;

  it('enregistrement en step-up, URL normalisée, aucun secret dans les réponses ni le journal', async () => {
    unconfigure();
    const empty = await browser.get<View>('/api/settings/whmcs');
    expect(empty.body.data).toEqual({ configured: false, values: {}, secrets: { identifier: false, secret: false, accessKey: false }, updatedAt: null });

    advance(6 * 60_000); // la fenêtre de step-up de la connexion est expirée
    const refused = await browser.put('/api/settings/whmcs', { url: BASE_URL, identifier: IDENTIFIER, secret: SECRET });
    expect(refused.status).toBe(403);
    expect(refused.errorCode).toBe('STEP_UP_REQUIRED');

    expect((await browser.stepUp(admin)).status).toBe(200);
    const saved = await browser.put<View>('/api/settings/whmcs', { url: ` ${BASE_URL}/includes/api.php `, identifier: IDENTIFIER, secret: SECRET, accessKey: ACCESS_KEY });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ configured: true, values: { url: BASE_URL }, secrets: { identifier: true, secret: true, accessKey: true } });
    expect(isWhmcsConfigured()).toBe(true);

    // Secret non resaisi = inchangé ; null = effacé (la clé d'accès est facultative).
    const partial = await browser.put<View>('/api/settings/whmcs', { url: `${BASE_URL}/`, secret: '', accessKey: null });
    expect(partial.body.data).toMatchObject({ configured: true, values: { url: BASE_URL }, secrets: { identifier: true, secret: true, accessKey: false } });

    const view = await browser.get<View>('/api/settings/whmcs');
    for (const raw of [saved.raw.body, partial.raw.body, view.raw.body]) {
      expect(raw).not.toContain(IDENTIFIER);
      expect(raw).not.toContain(SECRET);
      expect(raw).not.toContain(ACCESS_KEY);
    }
    const stored = db.prepare("SELECT data_enc FROM integration_settings WHERE namespace = 'whmcs'").get() as { data_enc: string };
    expect(stored.data_enc).not.toContain(SECRET);
    const audits = JSON.stringify(db.prepare("SELECT * FROM audit_log WHERE action LIKE 'settings.whmcs.%'").all());
    expect(audits).toContain('settings.whmcs.update');
    for (const value of [IDENTIFIER, SECRET, ACCESS_KEY]) expect(audits).not.toContain(value);
  });

  it('URL : https exigé sauf hôte local ; ni identifiants, ni paramètres, ni champ inconnu', async () => {
    expect((await browser.stepUp(admin)).status).toBe(200);
    const rejected = [
      'http://whmcs.exemple.test',
      'http://8.8.8.8/whmcs',
      'ftp://whmcs.exemple.test',
      'pas une url',
      '',
      'https://admin:motdepasse@whmcs.exemple.test',
      'https://whmcs.exemple.test/?a=1',
      'javascript:alert(1)',
      'file:///etc/passwd',
    ];
    for (const url of rejected) {
      const res = await browser.put('/api/settings/whmcs', { url });
      expect([url, res.status, res.errorCode]).toEqual([url, 400, 'VALIDATION_ERROR']);
    }
    expect((await browser.put('/api/settings/whmcs', { url: BASE_URL, inconnu: 'x' })).status).toBe(400);
    expect((await browser.put('/api/settings/whmcs', { url: BASE_URL, secret: 12345 })).status).toBe(400);

    for (const [url, expected] of [
      ['http://localhost:8080/whmcs/', 'http://localhost:8080/whmcs'],
      ['http://127.0.0.1', 'http://127.0.0.1'],
      ['http://192.168.1.20/', 'http://192.168.1.20'],
      ['http://[::1]:8443', 'http://[::1]:8443'],
      ['https://client.exemple.test/facturation///', 'https://client.exemple.test/facturation'],
    ] as const) {
      // Changer d'URL alors que des clés sont enregistrées exige de les ressaisir (voir le test suivant).
      const res = await browser.put<View>('/api/settings/whmcs', { url, identifier: IDENTIFIER, secret: SECRET });
      expect([url, res.status, res.body.data?.values.url]).toEqual([url, 200, expected]);
    }
  });

  it('changement d’URL : refusé sans ressaisie de tous les secrets conservés, accepté avec', async () => {
    const OTHER = 'https://attaquant.exemple.test';
    setSettings('whmcs', { url: BASE_URL, identifier: IDENTIFIER, secret: SECRET, accessKey: ACCESS_KEY });
    clearWhmcsCache();
    expect((await browser.stepUp(admin)).status).toBe(200);
    const storedUrl = () => getSettings<{ url: string }>('whmcs')!.url;
    const required = (res: { body: { error?: { details?: unknown } } }) => [...((res.body.error?.details as { secretsRequired: string[] }).secretsRequired)].sort();

    // Aucun secret ressaisi : refus, rien n'est enregistré, aucune requête ne part vers la nouvelle URL.
    const bare = await browser.put('/api/settings/whmcs', { url: OTHER });
    expect([bare.status, bare.errorCode]).toEqual([400, 'VALIDATION_ERROR']);
    expect(required(bare)).toEqual(['accessKey', 'identifier', 'secret']);
    expect(storedUrl()).toBe(BASE_URL);

    // Secrets vides (= « inchangés ») ou ressaisie partielle : toujours refusé, avec la liste de ce qui manque.
    const blank = await browser.put('/api/settings/whmcs', { url: OTHER, identifier: '', secret: '', accessKey: '' });
    expect(blank.status).toBe(400);
    expect(required(blank)).toEqual(['accessKey', 'identifier', 'secret']);
    const partial = await browser.put('/api/settings/whmcs', { url: OTHER, identifier: IDENTIFIER, secret: SECRET });
    expect(partial.status).toBe(400);
    expect(required(partial)).toEqual(['accessKey']);
    expect(storedUrl()).toBe(BASE_URL);
    expect(whmcs.calls.length).toBe(0);
    for (const res of [bare, blank, partial]) {
      for (const value of [IDENTIFIER, SECRET, ACCESS_KEY]) expect(res.raw.body).not.toContain(value);
    }
    const refusals = db.prepare("SELECT details FROM audit_log WHERE action = 'settings.whmcs.update' AND success = 0 AND details LIKE '%secrets_required%'").all();
    expect(refusals.length).toBeGreaterThanOrEqual(3);

    // La même URL (après normalisation) n'est pas un changement : aucune ressaisie demandée.
    expect((await browser.put('/api/settings/whmcs', { url: `${BASE_URL}/includes/api.php` })).status).toBe(200);

    // Tous les secrets conservés ressaisis : accepté.
    const full = await browser.put<View>('/api/settings/whmcs', { url: OTHER, identifier: IDENTIFIER, secret: SECRET, accessKey: ACCESS_KEY });
    expect(full.status).toBe(200);
    expect(full.body.data).toMatchObject({ configured: true, values: { url: OTHER }, secrets: { identifier: true, secret: true, accessKey: true } });
    expect(storedUrl()).toBe(OTHER);

    // Un secret effacé dans la même requête n'est plus « conservé » : seuls les autres sont à ressaisir.
    const cleared = await browser.put<View>('/api/settings/whmcs', { url: BASE_URL, identifier: IDENTIFIER, secret: SECRET, accessKey: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ values: { url: BASE_URL }, secrets: { identifier: true, secret: true, accessKey: false } });
    for (const res of [full, cleared]) {
      for (const value of [IDENTIFIER, SECRET, ACCESS_KEY]) expect(res.raw.body).not.toContain(value);
    }
  });

  it('test de connexion (step-up) : succès, puis échec sobre sans secret', async () => {
    whmcs.clients = [client(1), client(2)];
    // Le test envoie les secrets enregistrés vers l'hôte configuré : refusé sans confirmation 2FA récente.
    advance(6 * 60_000);
    const refused = await browser.post('/api/settings/whmcs/test');
    expect([refused.status, refused.errorCode]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(whmcs.calls.length).toBe(0);
    expect((await browser.stepUp(admin)).status).toBe(200);
    const ok = await browser.post<SettingsTestResult>('/api/settings/whmcs/test');
    expect(ok.body.data).toEqual({ ok: true, message: 'Connexion à WHMCS réussie (2 client(s))' });
    expect(whmcs.calls).toHaveLength(1);
    expect(whmcs.calls[0]!.params).toMatchObject({ action: 'GetClients', limitnum: '1' });

    setSettings('whmcs', { url: BASE_URL, identifier: IDENTIFIER, secret: 'mauvais-secret-ZZZ' });
    const ko = await browser.post<SettingsTestResult>('/api/settings/whmcs/test');
    expect(ko.status).toBe(200);
    expect(ko.body.data).toEqual({ ok: false, message: 'Identifiants API WHMCS refusés' });
    expect(ko.raw.body).not.toContain('mauvais-secret-ZZZ');

    unconfigure();
    expect((await browser.post<SettingsTestResult>('/api/settings/whmcs/test')).body.data).toEqual({ ok: false, message: 'Intégration non configurée' });
  });
});

// ───────────────────────────── Service inter-modules ─────────────────────────────

describe('service : findClientByEmail / findClientsByEmails', () => {
  beforeEach(() => {
    whmcs.clients = [
      client(1, { firstname: 'Ana', lastname: 'Silva', email: 'Ana.Silva@Exemple.test', companyname: 'Silva &amp; Co' }),
      client(2, { email: 'doublon@exemple.test', status: 'Closed' }),
      client(3, { email: 'doublon@exemple.test', status: 'Active' }),
      client(4, { email: '' }),
    ];
  });

  it('insensible à la casse, dédoublonnée, clés en minuscules, une seule lecture de l’annuaire', async () => {
    const found = await findClientsByEmails(['ANA.SILVA@exemple.TEST', ' ana.silva@exemple.test ', 'inconnu@exemple.test', 'doublon@exemple.test', '', 'pas-un-mail']);
    expect([...found.keys()].sort()).toEqual(['ana.silva@exemple.test', 'doublon@exemple.test']);
    expect(found.get('ana.silva@exemple.test')).toEqual({ id: 1, name: 'Ana Silva', email: 'Ana.Silva@Exemple.test', companyName: 'Silva & Co', status: 'Active' });
    // Même e-mail sur deux fiches : la fiche active l'emporte.
    expect(found.get('doublon@exemple.test')!.id).toBe(3);
    expect(whmcs.calls.length).toBe(1);

    expect(await findClientByEmail('Ana.Silva@EXEMPLE.test')).toMatchObject({ id: 1 });
    expect(await findClientByEmail('inconnu@exemple.test')).toBeNull();
    expect(await findClientByEmail('')).toBeNull();
    expect((await findClientsByEmails([])).size).toBe(0);
    expect(whmcs.calls.length).toBe(1); // tout vient du cache

    // Appels concurrents à froid : toujours une seule lecture.
    clearWhmcsCache();
    whmcs.calls = [];
    whmcs.delayMs = 5;
    await Promise.all([findClientByEmail('ana.silva@exemple.test'), findClientsByEmails(['doublon@exemple.test']), findClientByEmail('x@y.test')]);
    expect(whmcs.calls.length).toBe(1);
  });

  it('ne lèvent jamais : non configuré, erreur WHMCS, panne réseau, entrées invalides', async () => {
    unconfigure();
    expect(isWhmcsConfigured()).toBe(false);
    expect(await findClientByEmail('ana.silva@exemple.test')).toBeNull();
    expect((await findClientsByEmails(['ana.silva@exemple.test'])).size).toBe(0);
    expect(whmcs.calls.length).toBe(0);

    configure();
    expect(isWhmcsConfigured()).toBe(true);
    whmcs.override = () => ({ status: 403, body: { result: 'error', message: 'Authentication Failed' } });
    expect(await findClientByEmail('ana.silva@exemple.test')).toBeNull();
    expect((await findClientsByEmails(['ana.silva@exemple.test'])).size).toBe(0);

    clearWhmcsCache();
    vi.mocked(upstreamFetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await findClientByEmail('ana.silva@exemple.test')).toBeNull();

    expect(await findClientByEmail(undefined as unknown as string)).toBeNull();
    expect((await findClientsByEmails(null as unknown as string[])).size).toBe(0);
    expect((await findClientsByEmails([42, null, {}] as unknown as string[])).size).toBe(0);
  });
});
