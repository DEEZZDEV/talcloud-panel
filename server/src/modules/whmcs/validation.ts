import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { normalizeBaseUrl } from '../../core/http.js';
import type { WhmcsSettings } from './client.js';

// ───────────────────────────── Réglages ─────────────────────────────

function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (!ipaddr.isValid(host)) return false;
  return ['loopback', 'private', 'uniqueLocal'].includes(ipaddr.process(host).range());
}

/**
 * https obligatoire (les identifiants API partent dans chaque requête), sauf vers la machine elle-même ou une
 * adresse IP privée. Ni identifiants dans l'URL, ni paramètres, ni fragment.
 */
function isAcceptableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLocalHost(url.hostname);
}

const secret = z.string().trim().min(1).max(256);

export const settingsSchema: z.ZodType<WhmcsSettings> = z.strictObject({
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine(isAcceptableUrl, 'URL invalide : https:// requis (http:// accepté uniquement vers localhost ou une IP privée), sans identifiants ni paramètres')
    // Tolère une URL collée avec le chemin de l'API.
    .transform((raw) => normalizeBaseUrl(raw).replace(/\/includes\/api\.php$/i, '')),
  identifier: secret.optional(),
  secret: secret.optional(),
  accessKey: secret.optional(),
});

// ───────────────────────────── Paramètres de route ─────────────────────────────

export const idParams = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d{0,9}$/, 'Identifiant invalide')
    .transform(Number)
    .refine((n) => n <= 2_147_483_647, 'Identifiant invalide'),
});

/** Statut insensible à la casse, ramené à la forme attendue par WHMCS. */
function statusParam<const T extends readonly [string, ...string[]]>(values: T) {
  return z
    .string()
    .trim()
    .max(40)
    .transform((value) => values.find((v) => v.toLowerCase() === value.toLowerCase()) ?? value)
    .pipe(z.enum(values))
    .optional();
}

const page = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().min(1).max(100).optional(),
};

export const CLIENT_STATUSES = ['Active', 'Inactive', 'Closed'] as const;
export const ORDER_STATUSES = ['Pending', 'Active', 'Fraud', 'Cancelled'] as const;
export const INVOICE_STATUSES = ['Paid', 'Unpaid', 'Overdue', 'Cancelled', 'Refunded', 'Draft', 'Collections', 'Payment Pending'] as const;

export const clientsQuery = z.object({ ...page, status: statusParam(CLIENT_STATUSES) });
export const ordersQuery = z.object({ ...page, status: statusParam(ORDER_STATUSES) });
export const invoicesQuery = z.object({ ...page, status: statusParam(INVOICE_STATUSES) });

export type ListQuery = { page: number; pageSize: number; search?: string | undefined; status?: string | undefined };

export const monthlyQuery = z.object({ months: z.coerce.number().int().min(1).max(24).default(12) });

/** Un paramètre vide (`?status=`) équivaut à un paramètre absent. */
export function cleanQuery(query: unknown): unknown {
  if (typeof query !== 'object' || query === null) return {};
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== ''));
}

// ───────────────────────────── Coûts ─────────────────────────────

const month = z
  .string()
  .regex(/^20\d{2}-(0[1-9]|1[0-2])$/, 'Mois attendu au format YYYY-MM');

export const COST_CATEGORIES = ['servers', 'licenses', 'network', 'software', 'staff', 'fees', 'other'] as const;
export const COST_RECURRENCES = ['monthly', 'yearly', 'one_time'] as const;

export const costInputSchema = z
  .strictObject({
    label: z.string().trim().min(1).max(120),
    category: z.enum(COST_CATEGORIES),
    amount: z
      .number()
      .min(0)
      .max(1_000_000_000)
      .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, 'Deux décimales au maximum'),
    recurrence: z.enum(COST_RECURRENCES),
    startMonth: month,
    endMonth: month.nullish().transform((value) => value ?? null),
    notes: z
      .string()
      .trim()
      .max(2000)
      .nullish()
      .transform((value) => (value ? value : null)),
  })
  .refine((cost) => cost.endMonth === null || cost.endMonth >= cost.startMonth, {
    path: ['endMonth'],
    message: 'Le mois de fin doit être postérieur ou égal au mois de début',
  })
  // Une dépense ponctuelle ne porte que sur son mois : un mois de fin n'a pas de sens, il est ignoré.
  .transform((cost) => (cost.recurrence === 'one_time' ? { ...cost, endMonth: null } : cost));
