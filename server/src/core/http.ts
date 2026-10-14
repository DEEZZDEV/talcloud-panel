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

/** Plafond par défaut d'une réponse distante : une page légitime fait bien moins de 1 Mo. */
export const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;

/**
 * Lit le corps d'une réponse distante en texte, sans jamais dépasser `maxBytes` en mémoire : une API compromise
 * (ou un intermédiaire, si TLS n'est pas vérifié) ne peut pas épuiser la mémoire du panel avec une réponse géante.
 * Au-delà du plafond, le flux est abandonné et une UPSTREAM_ERROR est levée.
 */
export async function readBodyLimited(integration: IntegrationName, res: Response, maxBytes = MAX_UPSTREAM_BYTES): Promise<string> {
  const tooLarge = () => upstream(integration, `Réponse trop volumineuse de ${LABELS[integration]}`, { kind: 'too_large' });
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw upstream(integration, `Réponse interrompue de ${LABELS[integration]}`);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Variante JSON : lève UPSTREAM_ERROR si le statut n'est pas 2xx ou si le corps n'est pas du JSON. */
export async function upstreamJson<T>(integration: IntegrationName, url: string | URL, options: UpstreamOptions = {}): Promise<T> {
  const res = await upstreamFetch(integration, url, options);
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw upstream(integration, `${LABELS[integration]} a répondu avec le statut ${res.status}`, { status: res.status });
  }
  if (res.status === 204) return undefined as T;
  const text = await readBodyLimited(integration, res);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw upstream(integration, `Réponse illisible de ${LABELS[integration]}`);
  }
}

/** Normalise une URL de base saisie par l'administrateur (sans slash final, http/https uniquement). */
export function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('URL invalide');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
