import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { notConfigured } from '../../core/errors.js';
import { getSettings } from '../../core/settings.js';

export const NAMESPACE = 'proxmox';

/**
 * Identifiant de jeton API Proxmox : `utilisateur@royaume!nom`.
 * Aucun espace ni caractère de contrôle n'est accepté : la valeur est insérée dans l'en-tête Authorization.
 */
const TOKEN_ID = /^[^\s:/!=@\u0000-\u001f\u007f]{1,64}(@[^\s:/!=@\u0000-\u001f\u007f]{1,64})?@[A-Za-z][A-Za-z0-9._-]{1,31}![A-Za-z][A-Za-z0-9._-]{1,127}$/;
/** Secret du jeton (un UUID chez Proxmox) : jeu de caractères volontairement restreint, sans espace. */
const TOKEN_SECRET = /^[A-Za-z0-9._~+/=-]{8,256}$/;

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g;
const MAX_CA_CERTS = 10;

/** URL de base de Proxmox : https obligatoire, sans identifiants, sans query ; « /api2/json » éventuel retiré. */
function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api2(\/json)?$/i, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** Valide un ou plusieurs certificats PEM (aucune clé privée ni autre contenu) et renvoie une forme normalisée. */
function normalizePem(raw: string): string | null {
  const blocks = raw.match(PEM_BLOCK);
  if (!blocks || blocks.length === 0 || blocks.length > MAX_CA_CERTS) return null;
  if (raw.replace(PEM_BLOCK, '').trim() !== '') return null;
  try {
    for (const block of blocks) new X509Certificate(block);
  } catch {
    return null;
  }
  return `${blocks.map((b) => b.trim().replace(/\r\n?/g, '\n')).join('\n')}\n`;
}

export const settingsSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .transform((raw, ctx) => {
      const normalized = normalizeUrl(raw);
      if (normalized === null) {
        ctx.issues.push({ code: 'custom', message: 'URL invalide : une adresse https:// est exigée (ex. https://pve.exemple.com:8006)', input: raw });
        return z.NEVER;
      }
      return normalized;
    }),
  tokenId: z.string().trim().regex(TOKEN_ID, 'Identifiant de jeton invalide : format attendu utilisateur@royaume!nom'),
  /** Vérification du certificat TLS : activée par défaut. */
  verifyTls: z.boolean().default(true),
  /** CA (ou certificat auto-signé) de confiance, au format PEM. Chaîne vide = aucun. */
  caCert: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .max(65_536)
      .transform((raw, ctx) => {
        const normalized = normalizePem(raw);
        if (normalized === null) {
          ctx.issues.push({ code: 'custom', message: 'Certificat invalide : un ou plusieurs certificats au format PEM sont attendus', input: '[certificat]' });
          return z.NEVER;
        }
        return normalized;
      })
      .optional(),
  ),
  tokenSecret: z.string().trim().regex(TOKEN_SECRET, 'Secret de jeton invalide').optional(),
});

export type ProxmoxSettings = z.output<typeof settingsSchema>;
export type ConfiguredSettings = ProxmoxSettings & { tokenSecret: string };

export function isConfigured(settings: ProxmoxSettings): settings is ConfiguredSettings {
  return Boolean(settings.url && settings.tokenId && settings.tokenSecret);
}

/** Réglages utilisables, sinon 409 INTEGRATION_NOT_CONFIGURED. */
export function requireSettings(): ConfiguredSettings {
  const stored = getSettings<ProxmoxSettings>(NAMESPACE);
  if (!stored || !isConfigured(stored)) throw notConfigured('proxmox');
  // Défense en profondeur : les valeurs relues en base repassent par le schéma avant de servir à une requête.
  const parsed = settingsSchema.safeParse(stored);
  if (!parsed.success || !isConfigured(parsed.data)) throw notConfigured('proxmox');
  return parsed.data;
}
