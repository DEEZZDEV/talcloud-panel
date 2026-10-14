import { z } from 'zod';
import { getSettings } from '../../core/settings.js';

export const SETTINGS_NAMESPACE = 'notifications';

const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
const DISCORD_PATH = /^\/api(?:\/v\d{1,2})?\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,200}$/;

/**
 * Protection SSRF : seule une URL de webhook Discord est acceptée (https, hôte Discord exact, port par défaut,
 * sans identifiants, chemin /api/webhooks/<id>/<jeton>). Retourne l'URL canonique, ou null si elle est refusée.
 * La chaîne de requête et le fragment sont retirés.
 */
export function parseDiscordWebhookUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 400) return null;
  // Espaces, antislashs et caractères de contrôle seraient « réparés » par l'analyseur d'URL : refus net.
  // eslint-disable-next-line no-control-regex
  if (/[\s\\\x00-\x1f\x7f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  const host = url.hostname.toLowerCase();
  if (!DISCORD_HOSTS.has(host)) return null;
  if (!DISCORD_PATH.test(url.pathname)) return null;
  return `https://${host}${url.pathname}`;
}

const MAX_GATEWAY_ACCOUNTS = 50;

/** Réglages stockés (chiffrés) de l'espace « notifications ». `discordWebhookUrl` est un secret. */
export const notificationSettingsSchema = z.strictObject({
  discordEnabled: z.boolean().default(false),
  notifyOrders: z.boolean().default(true),
  notifyPayments: z.boolean().default(true),
  gatewayAccounts: z
    .record(
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9_.\- ]+$/, 'Identifiant de passerelle invalide'),
      z.string().trim().min(1).max(120),
    )
    .refine((value) => Object.keys(value).length <= MAX_GATEWAY_ACCOUNTS, `Au plus ${MAX_GATEWAY_ACCOUNTS} passerelles`)
    .default({}),
  discordWebhookUrl: z
    .string()
    .max(400)
    .transform((value, ctx) => {
      const url = parseDiscordWebhookUrl(value);
      if (url === null) {
        ctx.addIssue({ code: 'custom', message: 'URL de webhook Discord attendue (https://discord.com/api/webhooks/…)' });
        return z.NEVER;
      }
      return url;
    })
    .optional(),
});

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

const DEFAULTS: NotificationSettings = { discordEnabled: false, notifyOrders: true, notifyPayments: true, gatewayAccounts: {} };

/** Réglages effectifs (valeurs par défaut si rien n'est enregistré ou si le contenu est illisible). */
export function getNotificationSettings(): NotificationSettings {
  try {
    const stored = getSettings<Record<string, unknown>>(SETTINGS_NAMESPACE);
    if (!stored) return { ...DEFAULTS };
    const parsed = notificationSettingsSchema.safeParse(stored);
    return parsed.success ? parsed.data : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Libellé du compte qui encaisse pour une passerelle (correspondance insensible à la casse), ou null. */
export function receivingAccountFor(gateway: string | null | undefined, accounts: Record<string, string>): string | null {
  if (!gateway) return null;
  const wanted = gateway.trim().toLowerCase();
  if (!wanted) return null;
  for (const [key, label] of Object.entries(accounts)) {
    if (key.trim().toLowerCase() === wanted && typeof label === 'string' && label.length > 0) return label;
  }
  return null;
}
