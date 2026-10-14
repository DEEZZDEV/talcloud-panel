import type { IntegrationName } from '@shared/api-types';
import { fetch, type Dispatcher, type RequestInit, type Response } from 'undici';
import { AppError, upstream } from './errors.js';

const LABELS: Record<IntegrationName, string> = {
  whmcs: 'WHMCS',
  pterodactyl: 'Pterodactyl',
  proxmox: 'Proxmox',
  mail: 'le serveur de messagerie',
  notifications: 'le service de notifications',
};

export interface UpstreamOptions extends Omit<RequestInit, 'signal' | 'dispatcher'> {
  timeoutMs?: number;
  /** Agent undici dédié (ex. TLS personnalisé pour Proxmox). */
  dispatcher?: Dispatcher;
}

/**
 * fetch vers une API distante avec délai maximal. Les erreurs réseau deviennent des UPSTREAM_ERROR
 * sans détail sensible : l'URL et les en-têtes (clés API) ne sont jamais renvoyés au client.
 */
export async function upstreamFetch(integration: IntegrationName, url: string | URL, options: UpstreamOptions = {}): Promise<Response> {
  const { timeoutMs = 15_000, ...init } = options;
  try {
    return await fetch(url, { ...init, redirect: init.redirect ?? 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const cause = err instanceof Error && err.cause instanceof Error ? (err.cause as NodeJS.ErrnoException).code : undefined;
    if (name === 'TimeoutError' || name === 'AbortError') throw upstream(integration, `Délai dépassé en contactant ${LABELS[integration]}`);
    throw upstream(integration, `Impossible de contacter ${LABELS[integration]}`, cause ? { cause } : undefined);
  }
}

/** Variante JSON : lève UPSTREAM_ERROR si le statut n'est pas 2xx ou si le corps n'est pas du JSON. */
export async function upstreamJson<T>(integration: IntegrationName, url: string | URL, options: UpstreamOptions = {}): Promise<T> {
  const res = await upstreamFetch(integration, url, options);
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw upstream(integration, `${LABELS[integration]} a répondu avec le statut ${res.status}`, { status: res.status });
  }
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw upstream(integration, `Réponse illisible de ${LABELS[integration]}`);
  }
}

/** Normalise une URL de base saisie par l'administrateur (sans slash final, http/https uniquement). */
export function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('URL invalide');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
