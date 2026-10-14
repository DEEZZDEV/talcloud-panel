import type { WhmcsClientRef } from '@shared/api-types';
import { cached, STATS_TTL_MS } from './cache.js';
import { loadWhmcsConfig, WhmcsApiError, whmcsCall } from './client.js';
import { getClientDirectory, mapClient, toRef } from './data.js';
import { isRecord } from './parse.js';

/**
 * Interface publique du module WHMCS pour les autres modules (mails, Pterodactyl).
 * Les signatures sont figées : seul le corps des fonctions est à implémenter.
 * Aucune de ces fonctions ne lève d'exception : WHMCS non configuré ou en erreur => null / Map vide.
 */

export function isWhmcsConfigured(): boolean {
  try {
    return loadWhmcsConfig() !== null;
  } catch {
    return false;
  }
}

/** Fiche client dont l'e-mail correspond (insensible à la casse), ou null. */
export async function findClientByEmail(email: string): Promise<WhmcsClientRef | null> {
  if (typeof email !== 'string') return null;
  const found = await findClientsByEmails([email]);
  return found.get(email.trim().toLowerCase()) ?? null;
}

/** Nombre maximal de recherches unitaires quand l'annuaire est incomplet (plafond de pages atteint). */
const MAX_DIRECT_LOOKUPS = 25;
const LOOKUP_CONCURRENCY = 4;

/** Recherche unitaire par e-mail (GetClientsDetails), mise en cache — résultat négatif compris. */
function lookupByEmail(email: string): Promise<WhmcsClientRef | null> {
  return cached(`clients:email:${email}`, STATS_TTL_MS, async () => {
    try {
      const body = await whmcsCall('GetClientsDetails', { email, stats: false });
      const client = mapClient(isRecord(body.client) ? body.client : body);
      return client.id > 0 && client.email.toLowerCase() === email ? toRef(client) : null;
    } catch (err) {
      if (err instanceof WhmcsApiError && err.kind === 'not_found') return null;
      throw err;
    }
  });
}

/**
 * Recherche groupée. Les clés de la Map sont les e-mails en minuscules.
 * Une seule lecture de l'annuaire des clients (en cache 5 min, partagée) sert toutes les adresses : relier 200
 * serveurs à leurs fiches ne coûte aucune requête supplémentaire. Une fiche créée dans WHMCS peut donc mettre
 * jusqu'à 5 minutes à être reconnue.
 */
export async function findClientsByEmails(emails: string[]): Promise<Map<string, WhmcsClientRef>> {
  const result = new Map<string, WhmcsClientRef>();
  try {
    if (!Array.isArray(emails) || !isWhmcsConfigured()) return result;
    const wanted = new Set<string>();
    for (const email of emails) {
      if (typeof email !== 'string') continue;
      const key = email.trim().toLowerCase();
      if (key.length >= 3 && key.length <= 254 && key.includes('@')) wanted.add(key);
    }
    if (wanted.size === 0) return result;

    const directory = await getClientDirectory();
    const missing: string[] = [];
    for (const email of wanted) {
      const client = directory.byEmail.get(email);
      if (client) result.set(email, client);
      else missing.push(email);
    }

    // Annuaire tronqué (très grosse base) : les adresses non trouvées sont demandées une à une, en nombre limité.
    if (directory.truncated) {
      const queue = missing.slice(0, MAX_DIRECT_LOOKUPS);
      for (let i = 0; i < queue.length; i += LOOKUP_CONCURRENCY) {
        const batch = queue.slice(i, i + LOOKUP_CONCURRENCY);
        const found = await Promise.allSettled(batch.map((email) => lookupByEmail(email)));
        found.forEach((outcome, index) => {
          if (outcome.status === 'fulfilled' && outcome.value) result.set(batch[index]!, outcome.value);
        });
      }
    }
    return result;
  } catch {
    return result;
  }
}
