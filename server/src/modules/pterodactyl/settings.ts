import { z } from 'zod';
import { notConfigured } from '../../core/errors.js';
import { normalizeBaseUrl } from '../../core/http.js';
import { getSettings } from '../../core/settings.js';

export const NAMESPACE = 'pterodactyl';

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Hôte de bouclage : seul cas où le HTTP en clair est toléré (les clés API transitent dans l'en-tête). */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

const urlSchema = z
  .string()
  .trim()
  .min(1, 'URL requise')
  .max(2048, 'URL trop longue')
  .refine((raw) => {
    const url = parseUrl(raw);
    return url !== null && (url.protocol === 'https:' || url.protocol === 'http:');
  }, 'URL invalide')
  .refine((raw) => {
    const url = parseUrl(raw);
    return !url || (url.username === '' && url.password === '');
  }, "L'URL ne doit pas contenir d'identifiants")
  .refine((raw) => {
    const url = parseUrl(raw);
    return !url || (url.search === '' && url.hash === '');
  }, "L'URL ne doit contenir ni paramètres ni ancre")
  .refine((raw) => {
    const url = parseUrl(raw);
    return !url || url.protocol !== 'http:' || isLoopbackHost(url.hostname);
  }, 'https:// est obligatoire (http:// accepté uniquement pour un hôte local)')
  .transform((raw) => normalizeBaseUrl(raw));

/**
 * Clé API Pterodactyl : caractères alphanumériques et « _ » uniquement (rien qui puisse altérer un en-tête HTTP).
 * Le préfixe n'est pas imposé (les panels antérieurs à la 1.8 n'en ont pas), mais une inversion des deux clés est refusée.
 */
const keySchema = (wrongPrefix: string, hint: string) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{16,128}$/, 'Format de clé inattendu')
    .refine((key) => !key.startsWith(wrongPrefix), hint);

export const settingsSchema = z.object({
  url: urlSchema,
  applicationKey: keySchema('ptlc_', 'Ceci est une clé Client (ptlc_…) : une clé Application (ptla_…) est attendue').optional(),
  clientKey: keySchema('ptla_', 'Ceci est une clé Application (ptla_…) : une clé Client (ptlc_…) est attendue').optional(),
});

export type StoredSettings = z.infer<typeof settingsSchema>;
export const secretFields = ['applicationKey', 'clientKey'] as const;

/** Réglages complets, utilisables pour appeler le panel. Ne sortent jamais du serveur. */
export interface PanelCredentials {
  url: string;
  applicationKey: string;
  clientKey: string;
}

export function isConfigured(settings: StoredSettings): boolean {
  return Boolean(settings.url && settings.applicationKey && settings.clientKey);
}

/** Lève 409 INTEGRATION_NOT_CONFIGURED tant que l'URL et les deux clés ne sont pas enregistrées. */
export function requireCredentials(): PanelCredentials {
  const stored = getSettings<StoredSettings>(NAMESPACE);
  if (!stored || !stored.url || !stored.applicationKey || !stored.clientKey) throw notConfigured('pterodactyl');
  return { url: stored.url, applicationKey: stored.applicationKey, clientKey: stored.clientKey };
}
