import type { Cost, PageMeta, WhmcsClient, WhmcsClientDetail, WhmcsInvoice, WhmcsMonthlyStats, WhmcsOrder, WhmcsOverview } from '@shared/api-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { audit } from '../../core/audit.js';
import { notFound } from '../../core/errors.js';
import { registerSettingsRoutes } from '../../core/settings-routes.js';
import { clearWhmcsCache } from './cache.js';
import { isUsable, requireWhmcsConfig, WHMCS_NAMESPACE, whmcsCall, type WhmcsSettings } from './client.js';
import { createCost, deleteCost, getCost, listCosts, updateCost } from './costs.js';
import { getClientDetail, listClients, listInvoices, listOrders, type ListResult } from './data.js';
import { int } from './parse.js';
import { monthlyStats, overview } from './stats.js';
import { cleanQuery, clientsQuery, costInputSchema, idParams, invoicesQuery, monthlyQuery, ordersQuery, settingsSchema, type ListQuery } from './validation.js';

/** `truncated` (ajout au contrat) n'apparaît que si la recherche n'a pas pu couvrir toutes les données. */
type ListMeta = PageMeta & { truncated?: true };

function page<T>(result: ListResult<T>, query: ListQuery): { data: T[]; meta: ListMeta } {
  const meta: ListMeta = { page: query.page, pageSize: query.pageSize, total: result.total };
  if (result.truncated) meta.truncated = true;
  return { data: result.items, meta };
}

const costTarget = (cost: Pick<Cost, 'id' | 'label'>): string => `coût #${cost.id} (${cost.label})`;

export default async function whmcsRoutes(app: FastifyInstance): Promise<void> {
  // ── Réglages : GET / PUT (step-up) / POST test — les secrets ne sortent jamais du serveur.
  registerSettingsRoutes<WhmcsSettings>(app, {
    namespace: WHMCS_NAMESPACE,
    schema: settingsSchema,
    secretFields: ['identifier', 'secret', 'accessKey'],
    destinationFields: ['url'],
    isConfigured: isUsable,
    onChange: clearWhmcsCache,
    async test(settings) {
      if (!isUsable(settings)) return { ok: false, message: 'Intégration non configurée' };
      // Action légère ; une erreur (AppError au message sobre) est convertie en échec par registerSettingsRoutes.
      const body = await whmcsCall('GetClients', { limitstart: 0, limitnum: 1 }, { settings, timeoutMs: 15_000 });
      return { ok: true, message: `Connexion à WHMCS réussie (${int(body.totalresults)} client(s))` };
    },
  });

  // ── Statistiques
  app.get('/api/whmcs/stats/overview', async (): Promise<{ data: WhmcsOverview }> => {
    requireWhmcsConfig();
    return { data: await overview() };
  });

  app.get('/api/whmcs/stats/monthly', async (request): Promise<{ data: WhmcsMonthlyStats }> => {
    const { months } = monthlyQuery.parse(cleanQuery(request.query));
    requireWhmcsConfig();
    return { data: await monthlyStats(months) };
  });

  // ── Clients, commandes, factures (lecture seule)
  app.get('/api/whmcs/clients', async (request): Promise<{ data: WhmcsClient[]; meta: ListMeta }> => {
    const query = clientsQuery.parse(cleanQuery(request.query));
    requireWhmcsConfig();
    return page(await listClients(query), query);
  });

  app.get('/api/whmcs/clients/:id', async (request): Promise<{ data: WhmcsClientDetail }> => {
    const { id } = idParams.parse(request.params);
    const settings = requireWhmcsConfig();
    return { data: await getClientDetail(id, settings.url) };
  });

  app.get('/api/whmcs/orders', async (request): Promise<{ data: WhmcsOrder[]; meta: ListMeta }> => {
    const query = ordersQuery.parse(cleanQuery(request.query));
    requireWhmcsConfig();
    return page(await listOrders(query), query);
  });

  app.get('/api/whmcs/invoices', async (request): Promise<{ data: WhmcsInvoice[]; meta: ListMeta }> => {
    const query = invoicesQuery.parse(cleanQuery(request.query));
    requireWhmcsConfig();
    return page(await listInvoices(query), query);
  });

  // ── Coûts saisis (stockés dans le panel : fonctionnent sans WHMCS). Toute écriture est journalisée.
  const parseCost = (request: FastifyRequest, action: string, target: string | null): z.output<typeof costInputSchema> => {
    const parsed = costInputSchema.safeParse(request.body);
    if (!parsed.success) {
      audit(request, { action, target, success: false, details: { reason: 'validation' } });
      throw parsed.error;
    }
    return parsed.data;
  };

  app.get('/api/whmcs/costs', async (): Promise<{ data: Cost[] }> => ({ data: listCosts() }));

  app.post('/api/whmcs/costs', async (request, reply): Promise<{ data: Cost }> => {
    const input = parseCost(request, 'whmcs.cost.create', null);
    const cost = createCost(input);
    audit(request, { action: 'whmcs.cost.create', target: costTarget(cost), details: { amount: cost.amount, recurrence: cost.recurrence, startMonth: cost.startMonth } });
    reply.status(201);
    return { data: cost };
  });

  app.put('/api/whmcs/costs/:id', async (request): Promise<{ data: Cost }> => {
    const { id } = idParams.parse(request.params);
    const input = parseCost(request, 'whmcs.cost.update', `coût #${id}`);
    const cost = updateCost(id, input);
    if (!cost) {
      audit(request, { action: 'whmcs.cost.update', target: `coût #${id}`, success: false, details: { reason: 'introuvable' } });
      throw notFound('Coût introuvable');
    }
    audit(request, { action: 'whmcs.cost.update', target: costTarget(cost), details: { amount: cost.amount, recurrence: cost.recurrence, startMonth: cost.startMonth } });
    return { data: cost };
  });

  app.delete('/api/whmcs/costs/:id', async (request): Promise<{ data: { deleted: true } }> => {
    const { id } = idParams.parse(request.params);
    const cost = getCost(id);
    if (!cost || !deleteCost(id)) {
      audit(request, { action: 'whmcs.cost.delete', target: `coût #${id}`, success: false, details: { reason: 'introuvable' } });
      throw notFound('Coût introuvable');
    }
    audit(request, { action: 'whmcs.cost.delete', target: costTarget(cost), details: { amount: cost.amount, recurrence: cost.recurrence } });
    return { data: { deleted: true } };
  });
}
