import type { WhmcsMonthlyPoint, WhmcsMonthlyStats, WhmcsOverview } from '@shared/api-types';
import { cached, STATS_TTL_MS } from './cache.js';
import { fetchAll, whmcsCall } from './client.js';
import { costsByMonth } from './costs.js';
import { currentRate, getClientDirectory, getCurrencies } from './data.js';
import { addMonths, currentMonth, int, monthOf, monthsEndingAt, num, round2, str } from './parse.js';

/**
 * RÈGLES DE CALCUL
 *
 * Chiffre d'affaires d'un mois = encaissements réels = Σ (amountin − amountout) des transactions WHMCS
 *   (GetTransactions) dont la date tombe dans le mois. Les remboursements (amountout) sont donc déduits, dans le
 *   mois où ils sont effectués. Ce n'est PAS le total facturé : une facture impayée ne compte pas.
 *
 * Frais de passerelle (`fees`) : comptés comme un COÛT, pas en déduction du chiffre d'affaires.
 *   coûts du mois = coûts saisis applicables + Σ fees des transactions du mois.
 *   (Ne pas ressaisir ces frais à la main dans la catégorie « fees », ils seraient comptés deux fois.)
 *
 * Bénéfice = chiffre d'affaires − coûts (frais de passerelle inclus). Ni TVA ni impôts ne sont retraités.
 *
 * Devises : tout est exprimé dans la devise par défaut de WHMCS. Chaque transaction porte le taux de change
 *   appliqué par WHMCS au moment du paiement (`rate`) : montant converti = montant / rate — la même règle que les
 *   rapports de revenus de WHMCS. Un taux absent ou nul est traité comme 1. Les factures impayées n'ont pas de taux
 *   propre : elles sont converties au taux COURANT de leur devise (approximation). Les coûts saisis sont supposés
 *   être dans la devise par défaut.
 *
 * Mois : le mois d'une transaction, d'une commande ou d'une inscription est lu tel que WHMCS l'écrit (son fuseau).
 *   Le « mois en cours » est celui de l'horloge du serveur du panel : définir TZ sur le fuseau de WHMCS.
 *
 * Arrondi : les sommes sont faites sur les valeurs brutes ; l'arrondi à 2 décimales n'est appliqué qu'en sortie.
 *   Le bénéfice affiché est la différence des deux montants affichés, pour que l'écran reste cohérent au centime.
 */

interface MonthFlow {
  revenue: number;
  fees: number;
}

interface Sourced<T> {
  value: T;
  truncated: boolean;
}

/** Encaissements et frais par mois, convertis dans la devise par défaut. Toutes les transactions sont lues. */
function getTransactionFlows(): Promise<Sourced<Map<string, MonthFlow>>> {
  return cached('stats:transactions', STATS_TTL_MS, async () => {
    const collected = await fetchAll('GetTransactions', {}, 'transactions', 'transaction', { timeoutMs: 60_000 });
    const months = new Map<string, MonthFlow>();
    for (const tx of collected.items) {
      const month = monthOf(tx.date);
      if (!month) continue;
      const rate = num(tx.rate) > 0 ? num(tx.rate) : 1;
      const flow = months.get(month) ?? { revenue: 0, fees: 0 };
      flow.revenue += (num(tx.amountin) - num(tx.amountout)) / rate;
      flow.fees += num(tx.fees) / rate;
      months.set(month, flow);
    }
    return { value: months, truncated: collected.truncated };
  });
}

/**
 * Nombre de commandes par mois depuis `since` (toutes les commandes passées, quel que soit leur statut).
 * GetOrders les renvoie de la plus récente à la plus ancienne : la lecture s'arrête dès qu'une page entière est
 * antérieure à la période.
 */
function getOrderCounts(since: string): Promise<Sourced<Map<string, number>>> {
  return cached(`stats:orders:${since}`, STATS_TTL_MS, async () => {
    const collected = await fetchAll('GetOrders', {}, 'orders', 'order', {
      stopWhen: (page) => page.every((order) => (monthOf(order.date) ?? '9999-99') < since),
    });
    const counts = new Map<string, number>();
    for (const order of collected.items) {
      const month = monthOf(order.date);
      if (month && month >= since) counts.set(month, (counts.get(month) ?? 0) + 1);
    }
    return { value: counts, truncated: collected.truncated };
  });
}

/** Nouveaux clients par mois, d'après la date de création des fiches. */
async function getNewClientCounts(): Promise<Sourced<Map<string, number>>> {
  const directory = await getClientDirectory();
  const counts = new Map<string, number>();
  for (const client of directory.clients) {
    const month = monthOf(client.createdAt);
    if (month) counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  return { value: counts, truncated: directory.truncated };
}

interface Series {
  currency: string;
  points: WhmcsMonthlyPoint[];
  truncated: boolean;
}

async function series(months: string[]): Promise<Series> {
  const since = months[0]!;
  const [currencies, flows, orders, clients] = await Promise.all([getCurrencies(), getTransactionFlows(), getOrderCounts(since), getNewClientCounts()]);
  const manualCosts = costsByMonth(months);

  const points = months.map((month): WhmcsMonthlyPoint => {
    const flow = flows.value.get(month);
    const revenue = round2(flow?.revenue ?? 0);
    const costs = round2((manualCosts.get(month) ?? 0) + (flow?.fees ?? 0));
    return {
      month,
      revenue,
      costs,
      profit: round2(revenue - costs),
      newClients: clients.value.get(month) ?? 0,
      orders: orders.value.get(month) ?? 0,
    };
  });
  return { currency: currencies.defaultCode, points, truncated: flows.truncated || orders.truncated || clients.truncated };
}

/** `months` derniers mois, mois en cours inclus, du plus ancien au plus récent ; mois sans donnée à zéro. */
export async function monthlyStats(months: number): Promise<WhmcsMonthlyStats & { truncated: boolean }> {
  return series(monthsEndingAt(currentMonth(), months));
}

/** Factures impayées (échues ou non) : nombre exact, total converti dans la devise par défaut. */
function getUnpaid(): Promise<Sourced<{ count: number; total: number }>> {
  return cached('stats:unpaid', STATS_TTL_MS, async () => {
    const [currencies, collected] = await Promise.all([getCurrencies(), fetchAll('GetInvoices', { status: 'Unpaid' }, 'invoices', 'invoice')]);
    const total = collected.items.reduce((sum, invoice) => sum + num(invoice.total) / currentRate(currencies, str(invoice.currencycode)), 0);
    return { value: { count: collected.total, total }, truncated: collected.truncated };
  });
}

function getActiveClientCount(): Promise<number> {
  return cached('stats:active-clients', STATS_TTL_MS, async () => int((await whmcsCall('GetClients', { status: 'Active', limitstart: 0, limitnum: 1 })).totalresults));
}

/** Variation en %, arrondie à 0,1 ; null si le mois précédent vaut zéro (division impossible). */
function delta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  const value = Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
  return value === 0 ? 0 : value;
}

/**
 * Mois en cours (donc partiel) comparé au mois précédent ENTIER : en début de mois les variations sont
 * mécaniquement négatives.
 */
export async function overview(): Promise<WhmcsOverview & { truncated: boolean }> {
  const month = currentMonth();
  const [stats, unpaid, activeClients] = await Promise.all([series([addMonths(month, -1), month]), getUnpaid(), getActiveClientCount()]);
  const previous = stats.points[0]!;
  const current = stats.points[1]!;
  return {
    currency: stats.currency,
    month,
    revenue: current.revenue,
    costs: current.costs,
    netProfit: current.profit,
    newClients: current.newClients,
    orders: current.orders,
    unpaidInvoices: { count: unpaid.value.count, total: round2(unpaid.value.total) },
    activeClients,
    deltas: {
      revenue: delta(current.revenue, previous.revenue),
      netProfit: delta(current.profit, previous.profit),
      newClients: delta(current.newClients, previous.newClients),
      orders: delta(current.orders, previous.orders),
    },
    truncated: stats.truncated || unpaid.truncated,
  };
}
