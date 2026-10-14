import { Agent } from 'undici';
import { AppError, upstream } from '../../core/errors.js';
import { upstreamFetch, readBodyLimited } from '../../core/http.js';
import type { ConfiguredSettings, ProxmoxSettings } from './settings.js';

/**
 * Client de l'API Proxmox VE (jeton API : aucun ticket ni cookie, donc pas de CSRFPreventionToken).
 * Le TLS est réglé sur un Agent undici DÉDIÉ : la vérification globale des certificats n'est jamais modifiée.
 */

let pool: { key: string; agent: Agent } | null = null;

function dispatcherFor(settings: ProxmoxSettings): Agent {
  const key = `${settings.verifyTls ? 1 : 0}:${settings.caCert ?? ''}`;
  if (pool?.key !== key) {
    void closeClient();
    pool = {
      key,
      agent: new Agent({
        connections: 8,
        allowH2: false,
        keepAliveTimeout: 10_000,
        headersTimeout: 20_000,
        bodyTimeout: 20_000,
        connect: {
          timeout: 10_000,
          rejectUnauthorized: settings.verifyTls,
          // Avec une CA fournie, SEULE celle-ci est acceptée (et non plus les autorités publiques).
          ...(settings.verifyTls && settings.caCert ? { ca: settings.caCert } : {}),
        },
      }),
    };
  }
  return pool.agent;
}

/** Ferme proprement l'agent courant (les requêtes en vol se terminent) ; le suivant sera recréé à la demande. */
export async function closeClient(): Promise<void> {
  const old = pool;
  pool = null;
  if (old) await old.agent.close().catch(() => undefined);
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_CHAIN_TOO_LONG',
  'INVALID_CA',
  'INVALID_PURPOSE',
  'HOSTNAME_MISMATCH',
  'EPROTO',
]);

const isTlsCode = (code: string): boolean => TLS_CODES.has(code) || code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL');

export type PveErrorKind = 'tls' | 'network' | 'timeout' | 'auth' | 'permission' | 'node' | 'remote' | 'invalid';

const detailsOf = (err: AppError): Record<string, unknown> => (typeof err.details === 'object' && err.details !== null ? (err.details as Record<string, unknown>) : {});

/** Nature d'une erreur levée par ce client (pour les journaux d'audit), sans rien de sensible. */
export function errorKind(err: unknown): PveErrorKind | null {
  if (!(err instanceof AppError) || err.code !== 'UPSTREAM_ERROR') return null;
  const kind = detailsOf(err).kind;
  return typeof kind === 'string' ? (kind as PveErrorKind) : null;
}

export type PveContext = 'read' | 'action';

/** Traduit un statut HTTP de Proxmox en message utile ; le corps de la réponse n'est jamais repris. */
function statusError(status: number, context: PveContext): AppError {
  const fail = (kind: PveErrorKind, message: string) => upstream('proxmox', message, { status, kind });
  switch (status) {
    case 401:
      return fail('auth', 'Proxmox a refusé le jeton API (identifiant ou secret incorrect, ou jeton expiré)');
    case 403:
      return fail(
        'permission',
        context === 'action'
          ? 'Le jeton API Proxmox n’a pas le privilège nécessaire pour cette action (VM.PowerMgmt)'
          : 'Le jeton API Proxmox n’a pas les privilèges nécessaires (VM.Audit, Sys.Audit)',
      );
    case 500:
      return fail(
        'remote',
        context === 'action'
          ? 'Proxmox a refusé l’action (invité verrouillé, déjà dans cet état ou tâche en conflit)'
          : 'Proxmox a signalé une erreur interne',
      );
    case 501:
      return fail('remote', 'Proxmox ne reconnaît pas cet appel (vérifiez l’URL de l’API)');
    case 595:
      return fail('node', 'Le node visé est injoignable depuis le cluster Proxmox');
    case 596:
    case 599:
      return fail('node', 'Le node Proxmox visé n’a pas répondu à temps');
    default:
      return fail('remote', `Proxmox a répondu avec le statut ${status}`);
  }
}

/** Requalifie une erreur réseau de core/http.ts : TLS, délai ou réseau. */
function transportError(err: AppError): AppError {
  const cause = detailsOf(err).cause;
  if (typeof cause === 'string' && isTlsCode(cause)) {
    return upstream(
      'proxmox',
      'Certificat TLS de Proxmox refusé (auto-signé, expiré ou nom d’hôte différent) : renseignez le certificat de la CA dans les réglages',
      { kind: 'tls', cause },
    );
  }
  if (typeof cause === 'string') return upstream('proxmox', 'Impossible de joindre Proxmox (réseau, DNS ou port)', { kind: 'network', cause });
  if (/Délai/.test(err.message)) return upstream('proxmox', 'Délai dépassé en contactant Proxmox', { kind: 'timeout' });
  return upstream('proxmox', 'Impossible de joindre Proxmox (réseau, DNS ou port)', { kind: 'network' });
}

export interface PveRequest {
  method?: 'GET' | 'POST';
  /** Chemin sous /api2/json, dont CHAQUE segment variable a été validé puis encodé par l'appelant. */
  path: string;
  query?: Record<string, string>;
  context?: PveContext;
  timeoutMs?: number;
}

/** Appelle l'API Proxmox et renvoie le champ `data` de la réponse. */
export async function pveRequest(settings: ConfiguredSettings, request: PveRequest): Promise<unknown> {
  const { method = 'GET', path, query, context = 'read', timeoutMs = 15_000 } = request;
  const url = new URL(`${settings.url}/api2/json${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

  let res;
  try {
    res = await upstreamFetch('proxmox', url, {
      method,
      timeoutMs,
      dispatcher: dispatcherFor(settings),
      headers: {
        accept: 'application/json',
        authorization: `PVEAPIToken=${settings.tokenId}=${settings.tokenSecret}`,
      },
    });
  } catch (err) {
    throw err instanceof AppError ? transportError(err) : upstream('proxmox', 'Impossible de joindre Proxmox (réseau, DNS ou port)', { kind: 'network' });
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw statusError(res.status, context);
  }
  const raw = await readBodyLimited('proxmox', res);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw upstream('proxmox', 'Réponse illisible de Proxmox (l’URL pointe-t-elle bien vers l’API ?)', { kind: 'invalid' });
  }
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw upstream('proxmox', 'Réponse inattendue de Proxmox', { kind: 'invalid' });
  }
  return (body as { data: unknown }).data;
}
