import type {
  GuestAction,
  GuestActionResult,
  GuestType,
  ProxmoxGuest,
  ProxmoxNode,
  ProxmoxNodeHistoryPoint,
  ProxmoxSummary,
  SettingsTestResult,
} from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit.js';
import { AppError, badRequest, notFound } from '../../core/errors.js';
import { assertStepUp } from '../../core/request.js';
import { registerSettingsRoutes } from '../../core/settings-routes.js';
import { ShortCache, mapLimit } from './cache.js';
import { closeClient, errorKind, pveRequest } from './client.js';
import {
  NODE_NAME,
  NODE_NAME_MAX,
  VMID_MAX,
  VMID_MIN,
  buildNodes,
  buildSummary,
  parseGuests,
  parseHistory,
  parseNodeStatus,
  parseNodes,
  parsePrivileges,
  parseVersion,
  type NodeStatusExtra,
  type RawNode,
} from './normalize.js';
import { NAMESPACE, isConfigured, requireSettings, settingsSchema, type ConfiguredSettings, type ProxmoxSettings } from './settings.js';

const CACHE_TTL_MS = 10_000;
const HISTORY_TTL_MS = 30_000;
/** Nombre maximal d'appels /nodes/:node/status simultanés. */
const STATUS_CONCURRENCY = 4;
/** Privilèges dont le jeton a besoin (voir README) ; leur absence est signalée par le test de connexion. */
const REQUIRED_PRIVILEGES = ['Sys.Audit', 'VM.Audit', 'VM.PowerMgmt'] as const;

// ── Validation des entrées ──

const nodeParam = z.string().max(NODE_NAME_MAX).regex(NODE_NAME, 'Nom de node invalide');
const vmidParam = z
  .string()
  .regex(/^[1-9][0-9]{2,8}$/, 'Identifiant d’invité invalide')
  .transform(Number)
  .pipe(z.number().int().min(VMID_MIN).max(VMID_MAX));

const historyParams = z.strictObject({ node: nodeParam });
const historyQuery = z.object({ timeframe: z.enum(['hour', 'day', 'week']).default('hour') });
const actionParams = z.strictObject({ node: nodeParam, type: z.enum(['qemu', 'lxc']), vmid: vmidParam });
const actionBody = z.strictObject({ action: z.enum(['start', 'shutdown', 'stop', 'reboot']) });

/** Actions qui interrompent un service : re-confirmation TOTP exigée. */
const STEP_UP_ACTIONS: ReadonlySet<GuestAction> = new Set(['shutdown', 'stop', 'reboot']);

// ── Lecture (avec cache court) ──

const cache = new ShortCache();
const segment = (value: string | number): string => encodeURIComponent(String(value));

const fetchGuests = async (settings: ConfiguredSettings): Promise<ProxmoxGuest[]> =>
  parseGuests(await pveRequest(settings, { path: '/cluster/resources', query: { type: 'vm' } }));
const fetchNodes = async (settings: ConfiguredSettings): Promise<RawNode[]> =>
  parseNodes(await pveRequest(settings, { path: '/cluster/resources', query: { type: 'node' } }));

const cachedGuests = (settings: ConfiguredSettings) => cache.get('guests', CACHE_TTL_MS, () => fetchGuests(settings));
const cachedRawNodes = (settings: ConfiguredSettings) => cache.get('raw-nodes', CACHE_TTL_MS, () => fetchNodes(settings));

async function loadNodes(settings: ConfiguredSettings): Promise<ProxmoxNode[]> {
  const [nodes, guests] = await Promise.all([cachedRawNodes(settings), cachedGuests(settings)]);
  const online = nodes.filter((n) => n.online);
  // Un node illisible ne fait pas échouer la liste : il est simplement présenté hors ligne.
  const extras = await mapLimit(online, STATUS_CONCURRENCY, async (node): Promise<[string, NodeStatusExtra | null]> => {
    try {
      return [node.node, parseNodeStatus(await pveRequest(settings, { path: `/nodes/${segment(node.node)}/status`, timeoutMs: 8_000 }))];
    } catch (err) {
      // Privilège manquant : le node répond, seules la charge et la version sont indisponibles.
      return [node.node, errorKind(err) === 'permission' ? { loadAverage: null, pveVersion: null } : null];
    }
  });
  return buildNodes(nodes, guests, new Map(extras));
}

/** Libellé lisible pour le journal. Le nom vient de Proxmox : caractères de contrôle retirés, longueur bornée. */
function targetLabel(type: GuestType, vmid: number, node: string, name?: string): string {
  const kind = type === 'qemu' ? 'VM' : 'CT';
  const clean = name?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
  return clean ? `${kind} ${vmid} (${clean}) @ ${node}` : `${kind} ${vmid} @ ${node}`;
}

async function testConnection(stored: ProxmoxSettings): Promise<SettingsTestResult> {
  const parsed = settingsSchema.safeParse(stored);
  if (!parsed.success || !isConfigured(parsed.data)) return { ok: false, message: 'Réglages Proxmox invalides : enregistrez-les à nouveau' };
  const settings = parsed.data;

  // Les erreurs (TLS, authentification, réseau) portent déjà un message sobre : elles remontent telles quelles.
  const version = parseVersion(await pveRequest(settings, { path: '/version', timeoutMs: 10_000 }));
  const parts = [version ? `Connexion réussie (Proxmox VE ${version}).` : 'Connexion réussie.'];

  // Vérification indicative des privilèges du jeton (un jeton à privilèges séparés sans ACL ne voit rien).
  try {
    const granted = parsePrivileges(await pveRequest(settings, { path: '/access/permissions', timeoutMs: 10_000 }));
    const missing = granted ? REQUIRED_PRIVILEGES.filter((p) => !granted.has(p)) : [];
    if (missing.length) parts.push(`Privilèges absents du jeton : ${missing.join(', ')}.`);
  } catch {
    // Vérification facultative : son échec ne remet pas en cause le test de connexion.
  }

  if (!settings.verifyTls) {
    parts.push('Attention : la vérification du certificat TLS est désactivée, la connexion peut être interceptée. Préférez le certificat de la CA.');
  }
  return { ok: true, message: parts.join(' ') };
}

export default async function proxmoxRoutes(app: FastifyInstance): Promise<void> {
  registerSettingsRoutes<ProxmoxSettings>(app, {
    namespace: NAMESPACE,
    schema: settingsSchema,
    secretFields: ['tokenSecret'],
    destinationFields: ['url', 'verifyTls', 'caCert'],
    isConfigured,
    test: testConnection,
    onChange: () => {
      // Nouvelle URL, nouveau jeton ou nouveau TLS : plus rien de l'ancien état ne doit servir.
      cache.clear();
      void closeClient();
    },
  });

  app.addHook('onClose', async () => {
    cache.clear();
    await closeClient();
  });

  app.get('/api/proxmox/nodes', async (): Promise<{ data: ProxmoxNode[] }> => {
    const settings = requireSettings();
    return { data: await cache.get('nodes', CACHE_TTL_MS, () => loadNodes(settings)) };
  });

  app.get('/api/proxmox/guests', async (): Promise<{ data: ProxmoxGuest[] }> => {
    const settings = requireSettings();
    return { data: await cachedGuests(settings) };
  });

  app.get('/api/proxmox/summary', { config: { background: true } }, async (): Promise<{ data: ProxmoxSummary }> => {
    const settings = requireSettings();
    const [nodes, guests] = await Promise.all([cachedRawNodes(settings), cachedGuests(settings)]);
    return { data: buildSummary(nodes, guests) };
  });

  app.get('/api/proxmox/nodes/:node/history', async (request): Promise<{ data: ProxmoxNodeHistoryPoint[] }> => {
    const { node } = historyParams.parse(request.params);
    const { timeframe } = historyQuery.parse(request.query);
    const settings = requireSettings();
    // Le chemin distant n'est construit que pour un node que Proxmox a lui-même annoncé.
    const known = (await cachedRawNodes(settings)).find((n) => n.node === node);
    if (!known) throw notFound('Node Proxmox inconnu');
    const data = await cache.get(`history:${known.node}:${timeframe}`, HISTORY_TTL_MS, async () =>
      parseHistory(await pveRequest(settings, { path: `/nodes/${segment(known.node)}/rrddata`, query: { timeframe, cf: 'AVERAGE' } })),
    );
    return { data };
  });

  app.post('/api/proxmox/guests/:node/:type/:vmid/action', async (request): Promise<{ data: GuestActionResult }> => {
    const params = actionParams.parse(request.params);
    const { action } = actionBody.parse(request.body);
    // Après la validation, avant tout appel distant.
    if (STEP_UP_ACTIONS.has(action)) assertStepUp(request);

    const auditAction = `proxmox.guest.${action}`;
    const details = { node: params.node, type: params.type, vmid: params.vmid };
    let target = targetLabel(params.type, params.vmid, params.node);

    try {
      const settings = requireSettings();
      // Liste relue à chaque action (jamais le cache) : l'invité doit exister à cet endroit précis, maintenant.
      const guest = (await fetchGuests(settings)).find((g) => g.vmid === params.vmid && g.type === params.type && g.node === params.node);
      if (!guest) throw notFound('Invité introuvable sur ce node');
      target = targetLabel(guest.type, guest.vmid, guest.node, guest.name);
      if (guest.template) throw badRequest('Action impossible sur un modèle (template)');

      // Segments issus de la réponse de Proxmox (déjà validés), encodés un à un.
      const path = `/nodes/${segment(guest.node)}/${segment(guest.type)}/${segment(guest.vmid)}/status/${segment(action)}`;
      const upid = await pveRequest(settings, { method: 'POST', path, context: 'action', timeoutMs: 20_000 });
      const taskId = typeof upid === 'string' ? upid.slice(0, 512) : '';

      cache.clear();
      audit(request, { action: auditAction, target, details: { ...details, taskId } });
      return { data: { taskId } };
    } catch (err) {
      // L'état distant est incertain après un échec : le cache est invalidé dans tous les cas.
      cache.clear();
      const reason = err instanceof AppError ? { code: err.code, reason: err.message } : { code: 'INTERNAL' };
      audit(request, { action: auditAction, target, success: false, details: { ...details, ...reason } });
      throw err;
    }
  });
}
