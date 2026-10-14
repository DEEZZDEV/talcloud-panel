import type { PowerSignal } from '@shared/api-types';
import { z } from 'zod';
import { AppError, notFound, upstream } from '../../core/errors.js';
import { upstreamFetch } from '../../core/http.js';
import type { PanelCredentials } from './settings.js';

/**
 * Client de l'API Pterodactyl (v1).
 *  - API Application (/api/application, clé ptla_…) : inventaire, suspension.
 *  - API Client (/api/client, clé ptlc_… d'un administrateur) : ressources en direct, signaux d'alimentation.
 * Les clés ne quittent ce fichier que dans l'en-tête Authorization ; aucun message d'erreur ne reprend
 * un corps de réponse distant, une URL ou un en-tête.
 */

type Api = 'application' | 'client';

interface CallOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  /** Nombre de nouvelles tentatives après un 429. */
  retries?: number;
  /** Attente maximale acceptée pour un Retry-After ; au-delà, l'appel échoue aussitôt. */
  maxWaitMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_WAIT_MS = 5_000;
const PAGE_SIZE = 100;
/** Garde-fou de pagination : 200 pages de 100 serveurs. */
const MAX_PAGES = 200;

/** Identifiant court d'un serveur : seul format accepté dans un chemin de l'API Client. */
const IDENTIFIER_RE = /^[A-Za-z0-9]{1,64}$/;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retry-After en millisecondes (secondes ou date HTTP) ; 1 s si absent ou illisible. */
export function parseRetryAfter(header: string | null, now = Date.now()): number {
  if (!header) return 1000;
  const value = header.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  // Date HTTP (RFC 9110) : toujours exprimée en GMT. Tout autre format est ignoré.
  const date = /GMT$/i.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(date)) return 1000;
  return Math.max(0, date - now);
}

function errorForStatus(api: Api, status: number): AppError {
  const key = api === 'application' ? 'Application' : 'Client';
  let message: string;
  if (status === 401 || status === 403) message = `Clé ${key} refusée par Pterodactyl (clé invalide ou permissions insuffisantes)`;
  else if (status === 404) message = 'Ressource introuvable sur Pterodactyl';
  else if (status === 409) message = "Pterodactyl refuse l'action : le serveur est suspendu, en installation ou en cours de transfert";
  else if (status === 429) message = 'Limite de débit de Pterodactyl atteinte, réessayez dans un instant';
  else message = `Pterodactyl a répondu avec le statut ${status}`;
  return upstream('pterodactyl', message, { status, api });
}

/** Statut HTTP distant porté par une erreur levée par ce client, sinon null. */
export function upstreamStatus(err: unknown): number | null {
  if (!(err instanceof AppError) || err.code !== 'UPSTREAM_ERROR') return null;
  const status = (err.details as { status?: unknown } | undefined)?.status;
  return typeof status === 'number' ? status : null;
}

async function call(creds: PanelCredentials, api: Api, path: string, options: CallOptions = {}): Promise<unknown> {
  const { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, maxWaitMs = DEFAULT_MAX_WAIT_MS } = options;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${api === 'application' ? creds.applicationKey : creds.clientKey}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const url = `${creds.url}/api/${api}${path}`;

  for (let attempt = 0; ; attempt += 1) {
    // redirect: 'error' (défaut de upstreamFetch) : la clé n'est jamais rejouée vers une autre origine.
    const res = await upstreamFetch('pterodactyl', url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs });

    if (res.status === 429 && attempt < retries) {
      const wait = parseRetryAfter(res.headers.get('retry-after'));
      await res.body?.cancel().catch(() => undefined);
      if (wait <= maxWaitMs) {
        await sleep(wait);
        continue;
      }
      throw errorForStatus(api, 429);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw errorForStatus(api, res.status);
    }
    if (res.status === 204) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    try {
      return await res.json();
    } catch {
      throw upstream('pterodactyl', 'Réponse illisible de Pterodactyl', { api });
    }
  }
}

function unreadable(api: Api): AppError {
  return upstream('pterodactyl', 'Réponse inattendue de Pterodactyl', { api });
}

// ───────────────────────────── API Application ─────────────────────────────

const count = z.number().finite().nonnegative().catch(0);

const serverAttributes = z.object({
  id: z.number().int().positive().max(2_147_483_647),
  identifier: z.string().regex(IDENTIFIER_RE),
  uuid: z.string().max(64).catch(''),
  name: z.string().catch(''),
  description: z.string().nullable().catch(null),
  status: z.string().nullable().catch(null),
  suspended: z.boolean().catch(false),
  node: z.number().int().nullable().catch(null),
  limits: z.object({ memory: count, disk: count, cpu: count }).catch({ memory: 0, disk: 0, cpu: 0 }),
  relationships: z
    .object({
      // Sans la permission correspondante, Pterodactyl renvoie une ressource nulle : la relation devient null.
      user: z
        .object({ attributes: z.object({ id: z.number().int(), username: z.string(), email: z.string() }) })
        .nullable()
        .catch(null),
      node: z
        .object({ attributes: z.object({ id: z.number().int(), name: z.string() }) })
        .nullable()
        .catch(null),
    })
    .partial()
    .catch({}),
});

const serverObject = z.object({ attributes: serverAttributes });

const serverList = z.object({
  data: z.array(z.unknown()),
  meta: z
    .object({ pagination: z.object({ current_page: z.number().int(), total_pages: z.number().int(), total: z.number().int().optional() }) })
    .optional()
    .catch(undefined),
});

/** Serveur tel que décrit par l'API Application, déjà validé. Les textes sont des données non fiables. */
export interface PanelServer {
  id: number;
  identifier: string;
  uuid: string;
  name: string;
  description: string | null;
  /** null = normal ; sinon installing, install_failed, suspended, restoring_backup… */
  status: string | null;
  suspended: boolean;
  nodeId: number | null;
  nodeName: string | null;
  /** Limites en unités Pterodactyl : Mio pour mémoire et disque, % pour le CPU ; 0 = illimité. */
  limits: { memoryMb: number; diskMb: number; cpuPercent: number };
  owner: { id: number; username: string; email: string } | null;
}

function toPanelServer(raw: unknown): PanelServer | null {
  const parsed = serverObject.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data.attributes;
  const user = a.relationships.user?.attributes ?? null;
  const node = a.relationships.node?.attributes ?? null;
  return {
    id: a.id,
    identifier: a.identifier,
    uuid: a.uuid,
    name: a.name,
    description: a.description === '' ? null : a.description,
    status: a.status,
    suspended: a.suspended || a.status === 'suspended',
    nodeId: node?.id ?? a.node,
    nodeName: node?.name ?? null,
    limits: { memoryMb: a.limits.memory, diskMb: a.limits.disk, cpuPercent: a.limits.cpu },
    owner: user ? { id: user.id, username: user.username, email: user.email } : null,
  };
}

/** Tous les serveurs du panel (toutes les pages). Un élément au format inattendu est ignoré et compté dans `skipped`. */
export async function listServers(creds: PanelCredentials): Promise<{ servers: PanelServer[]; skipped: number }> {
  const servers: PanelServer[] = [];
  const seen = new Set<number>();
  let skipped = 0;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const parsed = serverList.safeParse(await call(creds, 'application', `/servers?include=user,node&per_page=${PAGE_SIZE}&page=${page}`));
    if (!parsed.success) throw unreadable('application');
    for (const item of parsed.data.data) {
      const server = toPanelServer(item);
      if (!server) skipped += 1;
      else if (!seen.has(server.id)) {
        seen.add(server.id);
        servers.push(server);
      }
    }
    const pagination = parsed.data.meta?.pagination;
    // Sans métadonnées de pagination, une page vide marque la fin.
    if (pagination ? page >= pagination.total_pages : parsed.data.data.length === 0) return { servers, skipped };
  }
  throw upstream('pterodactyl', 'Trop de serveurs à énumérer sur Pterodactyl');
}

/** Un serveur par son id interne. Lève 404 s'il n'existe pas. */
export async function getServer(creds: PanelCredentials, id: number): Promise<PanelServer> {
  let raw: unknown;
  try {
    raw = await call(creds, 'application', `/servers/${encodeURIComponent(String(id))}?include=user,node`);
  } catch (err) {
    if (upstreamStatus(err) === 404) throw notFound('Serveur introuvable');
    throw err;
  }
  const server = toPanelServer(raw);
  // Défense en profondeur : la réponse doit bien décrire le serveur demandé.
  if (!server || server.id !== id) throw unreadable('application');
  return server;
}

export async function setSuspended(creds: PanelCredentials, id: number, suspended: boolean): Promise<void> {
  await call(creds, 'application', `/servers/${encodeURIComponent(String(id))}/${suspended ? 'suspend' : 'unsuspend'}`, { method: 'POST' });
}

/** Vérifie la clé Application ; renvoie le nombre de serveurs si le panel l'indique. */
export async function probeApplication(creds: PanelCredentials): Promise<number | null> {
  const parsed = serverList.safeParse(await call(creds, 'application', '/servers?per_page=1', { retries: 0 }));
  if (!parsed.success) throw unreadable('application');
  return parsed.data.meta?.pagination.total ?? null;
}

// ───────────────────────────── API Client ─────────────────────────────

const statsObject = z.object({
  attributes: z.object({
    current_state: z.string().catch(''),
    is_suspended: z.boolean().catch(false),
    resources: z.object({ memory_bytes: count, cpu_absolute: count, disk_bytes: count, uptime: count }),
  }),
});

export interface PanelStats {
  currentState: string;
  suspended: boolean;
  cpuPercent: number;
  memoryBytes: number;
  diskBytes: number;
  uptimeMs: number;
}

function assertIdentifier(identifier: string): void {
  if (!IDENTIFIER_RE.test(identifier)) throw unreadable('application');
}

/** Ressources en direct d'un serveur. `identifier` provient TOUJOURS d'une réponse de l'API Application. */
export async function getResources(creds: PanelCredentials, identifier: string, options: Pick<CallOptions, 'timeoutMs' | 'retries' | 'maxWaitMs'> = {}): Promise<PanelStats> {
  assertIdentifier(identifier);
  const parsed = statsObject.safeParse(await call(creds, 'client', `/servers/${encodeURIComponent(identifier)}/resources`, options));
  if (!parsed.success) throw unreadable('client');
  const { current_state, is_suspended, resources } = parsed.data.attributes;
  return {
    currentState: current_state,
    suspended: is_suspended,
    cpuPercent: resources.cpu_absolute,
    memoryBytes: resources.memory_bytes,
    diskBytes: resources.disk_bytes,
    uptimeMs: resources.uptime,
  };
}

/** Signal d'alimentation. `identifier` provient TOUJOURS d'une réponse de l'API Application. */
export async function sendPower(creds: PanelCredentials, identifier: string, signal: PowerSignal): Promise<void> {
  assertIdentifier(identifier);
  await call(creds, 'client', `/servers/${encodeURIComponent(identifier)}/power`, { method: 'POST', body: { signal } });
}

/** Vérifie la clé Client ; indique si le compte est administrateur (null si le panel ne le précise pas). */
export async function probeClient(creds: PanelCredentials): Promise<{ admin: boolean | null }> {
  const parsed = z.object({ attributes: z.object({ admin: z.boolean().nullable().catch(null) }) }).safeParse(await call(creds, 'client', '/account', { retries: 0 }));
  if (!parsed.success) throw unreadable('client');
  return { admin: parsed.data.attributes.admin };
}
