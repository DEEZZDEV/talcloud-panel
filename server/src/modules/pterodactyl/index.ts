import type { GameServer, PterodactylSummary, SettingsTestResult } from '@shared/api-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit.js';
import { AppError } from '../../core/errors.js';
import { assertStepUp } from '../../core/request.js';
import { registerSettingsRoutes } from '../../core/settings-routes.js';
import { getServer, probeApplication, probeClient, sendPower, setSuspended, type PanelServer } from './client.js';
import { getServerById, getServers, invalidateCache, summarize } from './servers.js';
import { isConfigured, NAMESPACE, requireCredentials, secretFields, settingsSchema, type PanelCredentials, type StoredSettings } from './settings.js';

/** `:id` = id interne Pterodactyl : entier positif en écriture décimale stricte (pas de signe, d'espace, d'exposant…). */
const idParams = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d{0,9}$/, 'Identifiant de serveur invalide')
    .transform(Number)
    .refine((n) => n <= 2_147_483_647, 'Identifiant de serveur invalide'),
});

const powerBody = z.strictObject({ signal: z.enum(['start', 'stop', 'restart', 'kill']) });

/** Cible lisible pour le journal. Le nom vient du panel (non fiable) : simplement tronqué, jamais interprété. */
const targetOf = (id: number, name?: string) => (name ? `serveur #${id} (${name.slice(0, 120)})` : `serveur #${id}`);

const failureMessage = (reason: unknown) => (reason instanceof AppError ? reason.message : 'erreur inattendue');

async function testConnection(settings: StoredSettings): Promise<SettingsTestResult> {
  const creds: PanelCredentials = { url: settings.url, applicationKey: settings.applicationKey ?? '', clientKey: settings.clientKey ?? '' };
  // Les deux clés sont vérifiées séparément pour dire laquelle pose problème (sans jamais l'afficher).
  const [application, client] = await Promise.allSettled([probeApplication(creds), probeClient(creds)]);

  const applicationOk = application.status === 'fulfilled';
  const notAdmin = client.status === 'fulfilled' && client.value.admin === false;
  const clientOk = client.status === 'fulfilled' && !notAdmin;
  if (applicationOk && clientOk) {
    const total = application.value;
    return { ok: true, message: `Connexion réussie : clé Application et clé Client valides${total === null ? '' : ` (${total} serveur${total > 1 ? 's' : ''})`}` };
  }

  const applicationLine = applicationOk ? 'Clé Application : valide' : `Clé Application : échec — ${failureMessage(application.reason)}`;
  let clientLine = 'Clé Client : valide';
  if (client.status === 'rejected') clientLine = `Clé Client : échec — ${failureMessage(client.reason)}`;
  else if (notAdmin) clientLine = "Clé Client : valide, mais le compte n'est pas administrateur (ressources et alimentation des serveurs des clients inaccessibles)";
  return { ok: false, message: `${applicationLine} · ${clientLine}` };
}

/**
 * Exécute une action sur un serveur et la journalise (succès comme échec).
 * Le serveur est relu auprès de l'API Application : c'est de cette réponse — jamais de la requête du client —
 * que proviennent l'identifiant envoyé à l'API Client et le nom inscrit au journal.
 */
async function runAction(
  request: FastifyRequest,
  id: number,
  action: string,
  details: Record<string, unknown>,
  perform: (creds: PanelCredentials, server: PanelServer) => Promise<void>,
): Promise<void> {
  let target = targetOf(id);
  try {
    const creds = requireCredentials();
    const server = await getServer(creds, id);
    target = targetOf(id, server.name);
    await perform(creds, server);
  } catch (err) {
    // Message sobre construit par ce module (AppError) : ni corps distant, ni URL, ni clé.
    const error = err instanceof AppError ? { code: err.code, message: err.message } : { code: 'INTERNAL', message: 'erreur inattendue' };
    audit(request, { action, target, success: false, details: { ...details, serverId: id, error } });
    throw err;
  } finally {
    invalidateCache();
  }
  audit(request, { action, target, details: { ...details, serverId: id } });
}

export default async function pterodactylRoutes(app: FastifyInstance): Promise<void> {
  registerSettingsRoutes<StoredSettings>(app, {
    namespace: NAMESPACE,
    schema: settingsSchema,
    secretFields,
    destinationFields: ['url'],
    isConfigured,
    test: testConnection,
    onChange: invalidateCache,
  });

  app.get('/api/pterodactyl/servers', async (): Promise<{ data: GameServer[] }> => ({ data: await getServers() }));

  app.get('/api/pterodactyl/servers/:id', async (request): Promise<{ data: GameServer }> => {
    const { id } = idParams.parse(request.params);
    return { data: await getServerById(id) };
  });

  // Interrogation périodique de la page d'accueil : ne prolonge pas la session.
  app.get('/api/pterodactyl/summary', { config: { background: true } }, async (): Promise<{ data: PterodactylSummary }> => ({ data: summarize(await getServers()) }));

  app.post('/api/pterodactyl/servers/:id/power', async (request) => {
    const { id } = idParams.parse(request.params);
    const { signal } = powerBody.parse(request.body);
    // Redémarrage, arrêt et kill interrompent le service d'un client : re-confirmation TOTP, avant tout appel distant.
    if (signal !== 'start') assertStepUp(request);
    await runAction(request, id, `pterodactyl.server.${signal}`, { signal }, (creds, server) => sendPower(creds, server.identifier, signal));
    return { data: { ok: true } };
  });

  app.post('/api/pterodactyl/servers/:id/suspend', { config: { stepUp: true } }, async (request) => {
    const { id } = idParams.parse(request.params);
    await runAction(request, id, 'pterodactyl.server.suspend', {}, (creds) => setSuspended(creds, id, true));
    return { data: { ok: true } };
  });

  app.post('/api/pterodactyl/servers/:id/unsuspend', async (request) => {
    const { id } = idParams.parse(request.params);
    await runAction(request, id, 'pterodactyl.server.unsuspend', {}, (creds) => setSuspended(creds, id, false));
    return { data: { ok: true } };
  });
}
