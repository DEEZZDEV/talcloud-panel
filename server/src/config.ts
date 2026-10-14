import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// En local le .env est à la racine du dépôt ; sous Docker les variables viennent de docker-compose.
dotenv.config({ path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env')], quiet: true });

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** URL publique exacte du panel (origine utilisée pour les contrôles CSRF et les liens dans les mails). */
  PUBLIC_URL: z.url(),
  DATA_DIR: z.string().default('./data'),
  /** Chemin de la base SQLite ; « :memory: » pour les tests. Par défaut DATA_DIR/talcloud.db. */
  DB_PATH: z.string().optional(),
  /** Clé maîtresse AES-256 : 64 caractères hexadécimaux (openssl rand -hex 32). */
  MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'MASTER_KEY doit contenir 64 caractères hexadécimaux'),
  /** Secret des HMAC (jetons de session, codes) : au moins 32 caractères. */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET doit contenir au moins 32 caractères'),
  /**
   * Proxys inverses de confiance (dont X-Forwarded-For / X-Forwarded-Proto sont crus) : liste d'IP ou de CIDR
   * séparés par des virgules, ou les alias loopback / linklocal / uniquelocal. « false » si exposé en direct.
   * Un simple nombre de sauts n'est pas accepté : il ne permet pas de vérifier qui envoie l'en-tête.
   */
  TRUST_PROXY: z.string().default('false'),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(240).default(15),
  SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(72).default(8),
  STEP_UP_MINUTES: z.coerce.number().int().min(1).max(30).default(5),
  IP_ALLOWLIST: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  SECURITY_DISCORD_WEBHOOK_URL: z.url().optional(),

  WHMCS_HOOK_SECRET: z.string().min(32, 'WHMCS_HOOK_SECRET doit contenir au moins 32 caractères').optional(),
  WHMCS_HOOK_IPS: z.string().optional(),

  GEOIP_DB_PATH: z.string().optional(),
  TRUST_CF_COUNTRY_HEADER: bool(false),

  WEB_DIST_DIR: z.string().default('../web/dist'),
  LOG_LEVEL: z.string().default('info'),
});

function parseTrustProxy(value: string): boolean | string[] {
  const v = value.trim().toLowerCase();
  if (v === 'false' || v === '0' || v === '') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) throw new Error('TRUST_PROXY doit lister des IP/CIDR de proxys (ex. « uniquelocal »), pas un nombre de sauts');
  return csv(value);
}

function load() {
  // Une variable vide (« CLE= ») est traitée comme absente.
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && value.trim() !== '') env[key] = value;
  }

  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Configuration invalide (.env) :\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';
  const publicUrl = new URL(e.PUBLIC_URL);

  const problems: string[] = [];
  if (isProd && publicUrl.protocol !== 'https:') problems.push('PUBLIC_URL doit être en https:// en production');
  if (isProd && !(e.SMTP_HOST && e.SMTP_FROM)) {
    problems.push('SMTP_HOST et SMTP_FROM sont obligatoires en production (codes de connexion et alertes par mail)');
  }
  if (problems.length) throw new Error(`Configuration invalide (.env) :\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  return {
    env: e.NODE_ENV,
    isProd,
    isTest: e.NODE_ENV === 'test',
    host: e.HOST,
    port: e.PORT,
    publicUrl: publicUrl.origin,
    dataDir: resolve(e.DATA_DIR),
    dbPath: e.DB_PATH ?? resolve(e.DATA_DIR, 'talcloud.db'),
    masterKey: Buffer.from(e.MASTER_KEY, 'hex'),
    sessionSecret: e.SESSION_SECRET,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    sessionIdleMs: e.SESSION_IDLE_MINUTES * 60_000,
    sessionMaxMs: e.SESSION_MAX_HOURS * 3_600_000,
    stepUpMs: e.STEP_UP_MINUTES * 60_000,
    ipAllowlist: csv(e.IP_ALLOWLIST),
    smtp: e.SMTP_HOST
      ? {
          host: e.SMTP_HOST,
          port: e.SMTP_PORT,
          secure: e.SMTP_SECURE,
          user: e.SMTP_USER,
          pass: e.SMTP_PASS,
          from: e.SMTP_FROM ?? e.SMTP_USER ?? `no-reply@${publicUrl.hostname}`,
        }
      : null,
    securityDiscordWebhookUrl: e.SECURITY_DISCORD_WEBHOOK_URL ?? null,
    whmcsHookSecret: e.WHMCS_HOOK_SECRET ?? null,
    whmcsHookIps: csv(e.WHMCS_HOOK_IPS),
    geoipDbPath: e.GEOIP_DB_PATH ?? null,
    trustCfCountryHeader: e.TRUST_CF_COUNTRY_HEADER,
    webDistDir: resolve(e.WEB_DIST_DIR),
    logLevel: e.LOG_LEVEL,
  } as const;
}

export type Config = ReturnType<typeof load>;
export const config: Config = load();
