import type { GameServer, GameServerState, PterodactylSummary, WhmcsClientRef } from '@shared/api-types';
import { notFound } from '../../core/errors.js';
import { findClientsByEmails } from '../whmcs/service.js';
import { getResources, listServers, upstreamStatus, type PanelServer, type PanelStats } from './client.js';
import { requireCredentials, type PanelCredentials } from './settings.js';

/** Durée de vie du cache de la liste : assez courte pour un affichage « en direct », assez longue pour ménager le panel. */
const CACHE_TTL_MS = 12_000;
const RESOURCE_CONCURRENCY = 8;
const RESOURCE_TIMEOUT_MS = 5_000;
/** Après ce nombre d'échecs réseau/5xx sur un même node, ses autres serveurs ne sont plus interrogés pendant ce rafraîchissement. */
const NODE_FAILURE_LIMIT = 2;
const MIB = 1024 * 1024;

const LIVE_STATES: Record<string, GameServerState> = { running: 'running', starting: 'starting', stopping: 'stopping', offline: 'offline' };

/** État normalisé : la suspension prime, puis l'installation, puis l'état en direct rapporté par Wings. */
export function normalizeState(server: Pick<PanelServer, 'status' | 'suspended'>, stats: Pick<PanelStats, 'currentState' | 'suspended'> | null): GameServerState {
  if (server.suspended || stats?.suspended) return 'suspended';
  if (server.status === 'installing') return 'installing';
  // install_failed, reinstall_failed, restoring_backup… : le serveur n'est pas dans un état exploitable.
  if (server.status !== null) return 'unknown';
  if (!stats) return 'unknown';
  return LIVE_STATES[stats.currentState] ?? 'unknown';
}

function toGameServer(creds: PanelCredentials, server: PanelServer, stats: PanelStats | null, whmcsClient: WhmcsClientRef | null): GameServer {
  return {
    id: server.id,
    identifier: server.identifier,
    uuid: server.uuid,
    name: server.name,
    description: server.description,
    node: server.nodeName,
    state: normalizeState(server, stats),
    suspended: server.suspended || Boolean(stats?.suspended),
    resources: stats
      ? {
          cpuPercent: Math.round(stats.cpuPercent * 100) / 100,
          memoryBytes: Math.round(stats.memoryBytes),
          diskBytes: Math.round(stats.diskBytes),
          uptimeMs: Math.round(stats.uptimeMs),
        }
      : null,
    limits: {
      cpuPercent: server.limits.cpuPercent,
      memoryBytes: Math.round(server.limits.memoryMb * MIB),
      diskBytes: Math.round(server.limits.diskMb * MIB),
    },
    owner: server.owner,
    whmcsClient,
    panelUrl: `${creds.url}/server/${encodeURIComponent(server.identifier)}`,
  };
}

/** Ressources de tous les serveurs, en parallèle borné. Un échec donne null pour ce serveur, jamais une erreur globale. */
async function fetchAllResources(creds: PanelCredentials, servers: PanelServer[]): Promise<(PanelStats | null)[]> {
  const results: (PanelStats | null)[] = servers.map(() => null);
  const nodeFailures = new Map<number, number>();
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const server = servers[index];
      if (!server) return;
      // Suspendu ou en installation : l'API Client répondrait 409, inutile de l'interroger.
      if (server.suspended || server.status !== null) continue;
      if (server.nodeId !== null && (nodeFailures.get(server.nodeId) ?? 0) >= NODE_FAILURE_LIMIT) continue;
      try {
        results[index] = await getResources(creds, server.identifier, { timeoutMs: RESOURCE_TIMEOUT_MS, retries: 1, maxWaitMs: 2_000 });
      } catch (err) {
        const status = upstreamStatus(err);
        // Délai dépassé, node injoignable (5xx relayé par le panel) : compte contre le node.
        if (server.nodeId !== null && (status === null || status >= 500)) nodeFailures.set(server.nodeId, (nodeFailures.get(server.nodeId) ?? 0) + 1);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(RESOURCE_CONCURRENCY, servers.length) }, worker));
  return results;
}

async function whmcsClientsFor(servers: PanelServer[]): Promise<Map<string, WhmcsClientRef>> {
  const emails = [...new Set(servers.flatMap((s) => (s.owner?.email ? [s.owner.email.trim().toLowerCase()] : [])))];
  if (emails.length === 0) return new Map();
  try {
    // Un seul appel groupé. Le contrat dit que la fonction ne lève pas ; on s'en protège malgré tout.
    return await findClientsByEmails(emails);
  } catch {
    return new Map();
  }
}

async function loadServers(creds: PanelCredentials): Promise<GameServer[]> {
  const { servers } = await listServers(creds);
  const [stats, clients] = await Promise.all([fetchAllResources(creds, servers), whmcsClientsFor(servers)]);
  return servers.map((server, i) => toGameServer(creds, server, stats[i] ?? null, (server.owner && clients.get(server.owner.email.trim().toLowerCase())) || null));
}

let cache: { at: number; servers: GameServer[] } | null = null;
let inflight: Promise<GameServer[]> | null = null;
/** Incrémenté à chaque invalidation : une requête partie avant ne remplit pas le cache. */
let generation = 0;

export function invalidateCache(): void {
  generation += 1;
  cache = null;
  inflight = null;
}

/** Liste des serveurs, avec cache court et une seule requête en vol. Lève 409 si l'intégration n'est pas configurée. */
export async function getServers(): Promise<GameServer[]> {
  const creds = requireCredentials();
  if (cache) {
    const age = Date.now() - cache.at;
    if (age >= 0 && age < CACHE_TTL_MS) return cache.servers;
  }
  if (inflight) return inflight;

  const startedAt = generation;
  const pending: Promise<GameServer[]> = loadServers(creds)
    .then((servers) => {
      if (startedAt === generation) cache = { at: Date.now(), servers };
      return servers;
    })
    .finally(() => {
      if (inflight === pending) inflight = null;
    });
  inflight = pending;
  return pending;
}

export async function getServerById(id: number): Promise<GameServer> {
  const server = (await getServers()).find((s) => s.id === id);
  if (!server) throw notFound('Serveur introuvable');
  return server;
}

export function summarize(servers: GameServer[]): PterodactylSummary {
  const offline = servers.filter((s) => s.state === 'offline' && !s.suspended);
  return {
    total: servers.length,
    running: servers.filter((s) => s.state === 'running').length,
    offline: offline.length,
    suspended: servers.filter((s) => s.suspended).length,
    offlineServers: offline.map((s) => ({ id: s.id, name: s.name, node: s.node })),
  };
}
