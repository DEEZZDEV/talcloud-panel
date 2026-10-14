import type { HomeBlockId, NotificationType, UserPreferences, UserPreferencesUpdate } from '@shared/api-types';
import { z } from 'zod';
import { db } from '../../db/index.js';

/**
 * Préférences de confort PROPRES à chaque administrateur (thème, types de notifications push, blocs de l'accueil,
 * boîte mail par défaut). Les données métier restent communes. Aucune préférence n'est un secret.
 */

export const HOME_BLOCK_IDS = ['stats', 'revenueChart', 'recentOrders', 'mail', 'offlineServices', 'notifications'] as const satisfies readonly HomeBlockId[];
const THEMES = ['dark', 'light', 'system'] as const;
const PUSH_KEYS = ['orders', 'payments', 'security', 'system'] as const;

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'dark',
  push: { orders: true, payments: true, security: true, system: true },
  home: { blocks: [...HOME_BLOCK_IDS] },
  mail: { defaultAccountId: null },
};

const defaults = (): UserPreferences => structuredClone(DEFAULT_PREFERENCES);

const blocksSchema = z
  .array(z.enum(HOME_BLOCK_IDS))
  .max(HOME_BLOCK_IDS.length)
  .refine((blocks) => new Set(blocks).size === blocks.length, 'Bloc en double');
const accountIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();

/** PUT /api/me/preferences : corps partiel, validation stricte (aucun champ inconnu, valeurs connues uniquement). */
export const preferencesUpdateSchema = z.strictObject({
  theme: z.enum(THEMES).optional(),
  push: z
    .strictObject({ orders: z.boolean().optional(), payments: z.boolean().optional(), security: z.boolean().optional(), system: z.boolean().optional() })
    .optional(),
  home: z.strictObject({ blocks: blocksSchema }).optional(),
  mail: z.strictObject({ defaultAccountId: accountIdSchema }).optional(),
});

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Fusionne des préférences stockées avec les valeurs par défaut, champ par champ : une clé absente (ajoutée dans une
 * version ultérieure) ou illisible prend sa valeur par défaut, sans invalider le reste.
 */
export function mergeWithDefaults(stored: unknown): UserPreferences {
  const result = defaults();
  if (!isRecord(stored)) return result;
  const theme = z.enum(THEMES).safeParse(stored.theme);
  if (theme.success) result.theme = theme.data;
  const push = stored.push;
  if (isRecord(push)) {
    for (const key of PUSH_KEYS) {
      const value = push[key];
      if (typeof value === 'boolean') result.push[key] = value;
    }
  }
  if (isRecord(stored.home)) {
    const blocks = blocksSchema.safeParse(stored.home.blocks);
    if (blocks.success) result.home.blocks = blocks.data;
  }
  if (isRecord(stored.mail)) {
    const account = accountIdSchema.safeParse(stored.mail.defaultAccountId);
    if (account.success) result.mail.defaultAccountId = account.data;
  }
  return result;
}

export function getPreferences(userId: number): UserPreferences {
  const row = db.prepare('SELECT data FROM user_preferences WHERE user_id = ?').get(userId) as { data: string } | undefined;
  if (!row) return defaults();
  try {
    return mergeWithDefaults(JSON.parse(row.data));
  } catch {
    return defaults();
  }
}

/** Applique une mise à jour partielle (déjà validée) et retourne les préférences complètes. */
export function updatePreferences(userId: number, update: UserPreferencesUpdate): UserPreferences {
  const next = getPreferences(userId);
  if (update.theme !== undefined) next.theme = update.theme;
  if (update.push) {
    for (const key of PUSH_KEYS) {
      const value = update.push[key];
      if (value !== undefined) next.push[key] = value;
    }
  }
  if (update.home) next.home.blocks = [...update.home.blocks];
  if (update.mail) next.mail.defaultAccountId = update.mail.defaultAccountId;
  db.prepare(
    `INSERT INTO user_preferences (user_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(userId, JSON.stringify(next), Date.now());
  return next;
}

const PUSH_KEY: Record<NotificationType, keyof UserPreferences['push']> = { order: 'orders', payment: 'payments', security: 'security', system: 'system' };

/** Le compte accepte-t-il les notifications push de ce type ? Oui par défaut, et en cas d'erreur de lecture. */
export function acceptsPush(userId: number, type: NotificationType): boolean {
  const key = PUSH_KEY[type];
  if (!key) return true;
  try {
    return getPreferences(userId).push[key];
  } catch {
    return true;
  }
}
