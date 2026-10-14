import type { WhmcsClient, WhmcsClientDetail, WhmcsClientRef, WhmcsInvoice, WhmcsOrder, WhmcsService } from '@shared/api-types';
import { notFound, upstream } from '../../core/errors.js';
import { cached, LIST_TTL_MS, STATS_TTL_MS } from './cache.js';
import { fetchAll, WhmcsApiError, whmcsCall, type Collected } from './client.js';
import { dateOnly, dateTimeIso, extractList, int, isRecord, num, numOrNull, round2, str, today, type Raw } from './parse.js';
import type { ListQuery } from './validation.js';

export interface ListResult<T> {
  items: T[];
  total: number;
  /** true si la recherche n'a porté que sur une partie des données (voir SEARCH_SCAN_PAGES). */
  truncated: boolean;
}

// ───────────────────────────── Devises ─────────────────────────────

export interface Currency {
  id: number;
  code: string;
  prefix: string;
  suffix: string;
  /** Taux par rapport à la devise par défaut (1 pour celle-ci). */
  rate: number;
}

export interface Currencies {
  list: Currency[];
  /** Devise par défaut de WHMCS : toutes les statistiques sont exprimées dans cette devise. */
  defaultCode: string;
}

export function getCurrencies(): Promise<Currencies> {
  return cached('currencies', STATS_TTL_MS, async () => {
    const body = await whmcsCall('GetCurrencies');
    const list = extractList(body, 'currencies', 'currency')
      .map((raw): Currency => ({ id: int(raw.id), code: (str(raw.code) ?? '').toUpperCase(), prefix: str(raw.prefix) ?? '', suffix: str(raw.suffix) ?? '', rate: num(raw.rate) }))
      .filter((currency) => currency.code !== '')
      .sort((a, b) => a.id - b.id);
    // La devise par défaut est celle dont le taux vaut 1 (à défaut, la première créée).
    const base = list.find((currency) => Math.abs(currency.rate - 1) < 1e-9) ?? list[0];
    if (!base) throw upstream('whmcs', 'WHMCS ne renvoie aucune devise');
    return { list, defaultCode: base.code };
  });
}

/** Taux courant d'une devise par rapport à la devise par défaut (1 si inconnue). */
export function currentRate(currencies: Currencies, code: string | null): number {
  const rate = currencies.list.find((currency) => currency.code === (code ?? '').toUpperCase())?.rate;
  return rate && rate > 0 ? rate : 1;
}

// ───────────────────────────── Conversions ─────────────────────────────

function fullName(raw: Raw): string {
  const name = [str(raw.firstname), str(raw.lastname)].filter(Boolean).join(' ');
  return name || str(raw.fullname) || str(raw.name) || str(raw.companyname) || '';
}

export function mapClient(raw: Raw): WhmcsClient {
  return {
    id: int(raw.id ?? raw.userid ?? raw.client_id),
    name: fullName(raw),
    email: str(raw.email) ?? '',
    companyName: str(raw.companyname),
    status: str(raw.status) ?? 'Unknown',
    createdAt: dateOnly(raw.datecreated),
    country: str(raw.countrycode) ?? str(raw.country),
    phone: str(raw.phonenumberformatted) ?? str(raw.phonenumber),
  };
}

export const toRef = (client: WhmcsClient): WhmcsClientRef => ({
  id: client.id,
  name: client.name,
  email: client.email,
  companyName: client.companyName,
  status: client.status,
});

function mapInvoice(raw: Raw, fallbackCurrency: string, day: string): WhmcsInvoice {
  const dueDate = dateOnly(raw.duedate);
  let status = str(raw.status) ?? 'Unknown';
  // WHMCS ne stocke pas « Overdue » : c'est une facture impayée dont l'échéance est passée.
  if (status === 'Unpaid' && dueDate !== null && dueDate < day) status = 'Overdue';
  return {
    id: int(raw.id),
    clientId: int(raw.userid),
    clientName: fullName(raw),
    date: dateOnly(raw.date) ?? '',
    dueDate,
    datePaid: dateTimeIso(raw.datepaid),
    total: round2(num(raw.total)),
    currency: str(raw.currencycode)?.toUpperCase() ?? fallbackCurrency,
    status,
    paymentMethod: str(raw.paymentmethod),
  };
}

function mapOrder(raw: Raw, currencies: Currencies): WhmcsOrder {
  const prefix = str(raw.currencyprefix) ?? '';
  const suffix = str(raw.currencysuffix) ?? '';
  // GetOrders ne donne pas le code devise, seulement préfixe et suffixe : on retrouve la devise par ces symboles.
  const currency = currencies.list.find((c) => c.prefix === prefix && c.suffix === suffix)?.code ?? currencies.defaultCode;
  const products = extractList(raw, 'lineitems', 'lineitem')
    .map((line) => str(line.product) ?? str(line.domain) ?? str(line.producttype))
    .filter((name): name is string => name !== null);
  const invoiceId = int(raw.invoiceid);
  return {
    id: int(raw.id),
    orderNumber: str(raw.ordernum) ?? '',
    clientId: int(raw.userid),
    clientName: str(raw.name) ?? fullName(raw),
    date: dateTimeIso(raw.date) ?? '',
    amount: round2(num(raw.amount)),
    currency,
    status: str(raw.status) ?? 'Unknown',
    paymentStatus: str(raw.paymentstatus),
    paymentMethod: str(raw.paymentmethodname) ?? str(raw.paymentmethod),
    products,
    invoiceId: invoiceId > 0 ? invoiceId : null,
  };
}

function mapService(raw: Raw): WhmcsService {
  return {
    id: int(raw.id),
    name: str(raw.translated_name) ?? str(raw.name) ?? str(raw.groupname) ?? `Service #${int(raw.id)}`,
    domain: str(raw.domain),
    status: str(raw.status) ?? 'Unknown',
    amount: round2(num(raw.recurringamount)),
    billingCycle: str(raw.billingcycle) ?? '',
    nextDueDate: dateOnly(raw.nextduedate),
  };
}

// ───────────────────────────── Annuaire des clients ─────────────────────────────

export interface ClientDirectory {
  clients: WhmcsClient[];
  /** Clé : e-mail en minuscules. */
  byEmail: Map<string, WhmcsClientRef>;
  total: number;
  truncated: boolean;
}

const statusRank = (status: string): number => (status === 'Active' ? 0 : status === 'Inactive' ? 1 : 2);

/**
 * Tous les clients (GetClients ne renvoie que id, nom, société, e-mail, date de création, statut), lus une fois
 * puis gardés 5 minutes. Sert à la recherche, au rapprochement par e-mail et au décompte des nouveaux clients.
 */
export function getClientDirectory(): Promise<ClientDirectory> {
  return cached('clients:directory', STATS_TTL_MS, async () => {
    const collected = await fetchAll('GetClients', { orderby: 'id', sorting: 'DESC' }, 'clients', 'client');
    const clients = collected.items.map(mapClient).filter((client) => client.id > 0);
    const byEmail = new Map<string, WhmcsClientRef>();
    for (const client of clients) {
      const key = client.email.toLowerCase();
      if (!key) continue;
      const existing = byEmail.get(key);
      // Même e-mail sur plusieurs fiches : la fiche active l'emporte, puis la plus ancienne.
      if (!existing || statusRank(client.status) < statusRank(existing.status) || (statusRank(client.status) === statusRank(existing.status) && client.id < existing.id)) {
        byEmail.set(key, toRef(client));
      }
    }
    return { clients, byEmail, total: collected.total, truncated: collected.truncated };
  });
}

// ───────────────────────────── Listes ─────────────────────────────

/**
 * Stratégie de recherche — l'API WHMCS ne sait pas chercher côté serveur dans les commandes ni les factures, et
 * sa recherche de clients ne porte que sur le DÉBUT des champs :
 *  - sans recherche : pagination faite par WHMCS (une requête par page, cache 60 s) ;
 *  - clients + recherche : filtrage local de l'annuaire complet (cache 5 min) — sous-chaîne, insensible à la casse ;
 *  - commandes / factures + recherche : filtrage local des SEARCH_SCAN_PAGES × 250 éléments les plus récents
 *    (cache 60 s). Au-delà, les éléments plus anciens ne sont pas trouvés : `truncated` vaut alors true.
 */
const SEARCH_SCAN_PAGES = 4;

function paginate<T>(all: T[], query: ListQuery, truncated: boolean): ListResult<T> {
  const start = (query.page - 1) * query.pageSize;
  return { items: all.slice(start, start + query.pageSize), total: all.length, truncated };
}

const matches = (needle: string, fields: (string | number | null)[]): boolean => {
  const wanted = needle.toLowerCase().replace(/^#/, '');
  return fields.some((field) => field !== null && String(field).toLowerCase().includes(wanted));
};

async function serverPage(action: 'GetClients' | 'GetOrders' | 'GetInvoices', params: Record<string, string | undefined>, container: string, item: string, query: ListQuery): Promise<Collected> {
  const body = await whmcsCall(action, { ...params, limitstart: (query.page - 1) * query.pageSize, limitnum: query.pageSize });
  const items = extractList(body, container, item).slice(0, query.pageSize);
  return { items, total: Math.max(int(body.totalresults), items.length), truncated: false };
}

export async function listClients(query: ListQuery): Promise<ListResult<WhmcsClient>> {
  if (query.search) {
    const directory = await getClientDirectory();
    const search = query.search;
    const found = directory.clients.filter(
      (client) => (!query.status || client.status === query.status) && matches(search, [client.name, client.email, client.companyName, client.id]),
    );
    return paginate(found, query, directory.truncated);
  }
  return cached(`clients:list:${query.status ?? ''}:${query.page}:${query.pageSize}`, LIST_TTL_MS, async () => {
    const page = await serverPage('GetClients', { status: query.status, orderby: 'id', sorting: 'DESC' }, 'clients', 'client', query);
    return { items: page.items.map(mapClient), total: page.total, truncated: false };
  });
}

export async function listOrders(query: ListQuery): Promise<ListResult<WhmcsOrder>> {
  const currencies = await getCurrencies();
  if (query.search) {
    const search = query.search;
    const scan = await cached(`orders:scan:${query.status ?? ''}`, LIST_TTL_MS, async () => {
      const collected = await fetchAll('GetOrders', { status: query.status }, 'orders', 'order', { maxPages: SEARCH_SCAN_PAGES });
      return { orders: collected.items.map((raw) => mapOrder(raw, currencies)), truncated: collected.truncated };
    });
    const found = scan.orders.filter((order) => matches(search, [order.id, order.orderNumber, order.clientName, order.invoiceId, order.paymentMethod, ...order.products]));
    return paginate(found, query, scan.truncated);
  }
  return cached(`orders:list:${query.status ?? ''}:${query.page}:${query.pageSize}`, LIST_TTL_MS, async () => {
    // GetOrders renvoie les commandes de la plus récente à la plus ancienne.
    const page = await serverPage('GetOrders', { status: query.status }, 'orders', 'order', query);
    return { items: page.items.map((raw) => mapOrder(raw, currencies)), total: page.total, truncated: false };
  });
}

export async function listInvoices(query: ListQuery): Promise<ListResult<WhmcsInvoice>> {
  const currencies = await getCurrencies();
  const params = { status: query.status, orderby: 'id', order: 'desc' };
  if (query.search) {
    const search = query.search;
    const scan = await cached(`invoices:scan:${query.status ?? ''}`, LIST_TTL_MS, async () => fetchAll('GetInvoices', params, 'invoices', 'invoice', { maxPages: SEARCH_SCAN_PAGES }));
    const day = today();
    const found = scan.items
      .filter((raw) => matches(search, [int(raw.id), str(raw.invoicenum), fullName(raw), str(raw.companyname)]))
      .map((raw) => mapInvoice(raw, currencies.defaultCode, day));
    return paginate(found, query, scan.truncated);
  }
  const page = await cached(`invoices:list:${query.status ?? ''}:${query.page}:${query.pageSize}`, LIST_TTL_MS, () => serverPage('GetInvoices', params, 'invoices', 'invoice', query));
  const day = today();
  return { items: page.items.map((raw) => mapInvoice(raw, currencies.defaultCode, day)), total: page.total, truncated: false };
}

// ───────────────────────────── Fiche client ─────────────────────────────

const RECENT_INVOICES = 10;

/**
 * Fiche complète : GetClientsDetails + GetClientsProducts + GetInvoices (du client) + GetTransactions (du client).
 * Les montants sont dans la devise DU CLIENT, sans conversion.
 */
export function getClientDetail(id: number, baseUrl: string): Promise<WhmcsClientDetail> {
  return cached(`clients:detail:${id}`, LIST_TTL_MS, async () => {
    let body: Raw;
    try {
      body = await whmcsCall('GetClientsDetails', { clientid: id, stats: false });
    } catch (err) {
      if (err instanceof WhmcsApiError && err.kind === 'not_found') throw notFound('Client introuvable');
      throw err;
    }
    const raw = isRecord(body.client) ? body.client : body;
    const client = mapClient(raw);
    if (client.id !== id) throw notFound('Client introuvable');

    const [products, invoices, transactions] = await Promise.all([
      fetchAll('GetClientsProducts', { clientid: id }, 'products', 'product', { maxPages: 4 }),
      fetchAll('GetInvoices', { userid: id, orderby: 'id', order: 'desc' }, 'invoices', 'invoice', { maxPages: 8 }),
      fetchAll('GetTransactions', { clientid: id }, 'transactions', 'transaction', { maxPages: 8 }),
    ]);

    const currency = str(raw.currency_code)?.toUpperCase() ?? (await getCurrencies()).defaultCode;
    const day = today();
    const services = products.items.map(mapService);
    const allInvoices = invoices.items.map((invoice) => mapInvoice({ ...invoice, firstname: invoice.firstname ?? raw.firstname, lastname: invoice.lastname ?? raw.lastname }, currency, day));
    // Encaissements réels du client, remboursements déduits.
    const totalPaid = transactions.items.reduce((sum, tx) => sum + num(tx.amountin) - num(tx.amountout), 0);
    const unpaidTotal = allInvoices.filter((invoice) => invoice.status === 'Unpaid' || invoice.status === 'Overdue').reduce((sum, invoice) => sum + invoice.total, 0);

    const cityLine = [str(raw.postcode), str(raw.city)].filter(Boolean).join(' ');
    const address = [str(raw.address1), str(raw.address2), cityLine || null, str(raw.fullstate) ?? str(raw.state), str(raw.countryname)].filter(Boolean).join(', ');

    return {
      ...client,
      address: address || null,
      credit: round2(numOrNull(raw.credit) ?? 0),
      currency,
      services,
      recentInvoices: allInvoices.slice(0, RECENT_INVOICES),
      stats: {
        totalPaid: round2(totalPaid),
        unpaidTotal: round2(unpaidTotal),
        activeServices: services.filter((service) => service.status === 'Active').length,
      },
      // Suppose le dossier d'administration par défaut (« admin ») : s'il a été renommé dans WHMCS, le lien est faux.
      adminUrl: `${baseUrl}/admin/clientssummary.php?userid=${id}`,
    };
  });
}
