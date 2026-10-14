/**
 * Cache mémoire du module WHMCS.
 *  - durée de vie par entrée ;
 *  - une seule requête en vol par clé : les appels concurrents attendent la même promesse (pas d'emballement
 *    quand plusieurs onglets ou les deux administrateurs rafraîchissent en même temps) ;
 *  - les échecs sont mémorisés brièvement, pour ne pas marteler un WHMCS en panne à chaque interrogation ;
 *  - nombre d'entrées plafonné (les clés de liste dépendent de paramètres de requête).
 */

interface Entry {
  value: unknown;
  failed: boolean;
  expiresAt: number;
}

const MAX_ENTRIES = 500;
const ERROR_TTL_MS = 10_000;

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
/** Incrémenté à chaque vidage : un chargement lancé avant le vidage ne réécrit pas le cache. */
let generation = 0;

function store(key: string, entry: Entry): void {
  if (!entries.has(key) && entries.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, e] of entries) if (e.expiresAt <= now) entries.delete(k);
    while (entries.size >= MAX_ENTRIES) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }
  entries.delete(key);
  entries.set(key, entry);
}

export function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.failed ? Promise.reject(hit.value) : Promise.resolve(hit.value as T);
  }
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const startedAt = generation;
  const promise: Promise<T> = (async () => loader())()
    .then(
      (value) => {
        if (startedAt === generation) store(key, { value, failed: false, expiresAt: Date.now() + ttlMs });
        return value;
      },
      (err: unknown) => {
        if (startedAt === generation) store(key, { value: err, failed: true, expiresAt: Date.now() + ERROR_TTL_MS });
        throw err;
      },
    )
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/** Vide tout le cache (changement de réglages, tests). */
export function clearWhmcsCache(): void {
  generation += 1;
  entries.clear();
  inflight.clear();
}

export const STATS_TTL_MS = 5 * 60_000;
export const LIST_TTL_MS = 60_000;
