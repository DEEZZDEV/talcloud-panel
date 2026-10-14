/**
 * Cache mémoire de courte durée avec UNE seule requête en vol par clé : des appels simultanés
 * (plusieurs onglets, rafraîchissements automatiques) ne multiplient pas les requêtes vers Proxmox.
 */
export class ShortCache {
  private readonly entries = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly flights = new Map<string, Promise<unknown>>();
  private generation = 0;

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    const flying = this.flights.get(key);
    if (flying) return flying as Promise<T>;

    const generation = this.generation;
    const flight = load()
      .then((value) => {
        // Un résultat parti avant une invalidation (action, changement de réglages) n'est pas mis en cache.
        if (generation === this.generation) this.entries.set(key, { expiresAt: Date.now() + ttlMs, value });
        return value;
      })
      .finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
      });
    this.flights.set(key, flight);
    return flight;
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.flights.clear();
  }
}

/** Applique `fn` à chaque élément avec au plus `limit` appels simultanés ; l'ordre des résultats est conservé. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
