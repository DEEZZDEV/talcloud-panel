import { AppError, notConfigured, upstream } from '../../core/errors.js';
import { upstreamFetch, MAX_UPSTREAM_BYTES, readBodyLimited } from '../../core/http.js';
import { getSettings } from '../../core/settings.js';
import { extractList, int, isRecord, type Raw } from './parse.js';

export const WHMCS_NAMESPACE = 'whmcs';

/** Réglages stockés (chiffrés) : `url` est une valeur, les trois autres sont des secrets. */
export type WhmcsSettings = {
  url: string;
  identifier?: string;
  secret?: string;
  accessKey?: string;
};

export type WhmcsConfig = WhmcsSettings & { identifier: string; secret: string };

export function isUsable(settings: WhmcsSettings | null | undefined): settings is WhmcsConfig {
  return Boolean(settings && settings.url && settings.identifier && settings.secret);
}

/** Réglages utilisables, ou null si l'intégration n'est pas configurée. */
export function loadWhmcsConfig(): WhmcsConfig | null {
  const settings = getSettings<WhmcsSettings>(WHMCS_NAMESPACE);
  return isUsable(settings) ? settings : null;
}

export function requireWhmcsConfig(): WhmcsConfig {
  const settings = loadWhmcsConfig();
  if (!settings) throw notConfigured('whmcs');
  return settings;
}

/**
 * Seules actions que ce module peut appeler : toutes en LECTURE SEULE. Le panel ne modifie jamais WHMCS.
 * C'est aussi la liste des permissions à accorder au rôle API dans WHMCS.
 */
export type WhmcsAction =
  | 'GetClients'
  | 'GetClientsDetails'
  | 'GetClientsProducts'
  | 'GetOrders'
  | 'GetInvoices'
  | 'GetTransactions'
  | 'GetCurrencies';

export type WhmcsErrorKind = 'auth' | 'ip' | 'permission' | 'not_found' | 'other';

/** Erreur `result: "error"` de WHMCS. Le message brut de WHMCS n'est jamais conservé ni renvoyé. */
export class WhmcsApiError extends AppError {
  constructor(
    public readonly kind: WhmcsErrorKind,
    message: string,
    details: Record<string, unknown>,
  ) {
    super(502, 'UPSTREAM_ERROR', message, { integration: 'whmcs', ...details });
  }
}

/** Traduit le message d'erreur WHMCS en message sobre : jamais de recopie du texte distant. */
function toApiError(action: WhmcsAction, rawMessage: unknown): WhmcsApiError {
  const message = typeof rawMessage === 'string' ? rawMessage : '';
  if (/invalid ip/i.test(message)) {
    // L'adresse citée est celle du panel vue par WHMCS : utile pour l'autoriser, et ce n'est pas un secret.
    const ip = /invalid ip:?\s*([0-9a-fA-F:.]{3,45})/i.exec(message)?.[1];
    return new WhmcsApiError(
      'ip',
      `WHMCS refuse l'adresse IP du panel${ip ? ` (${ip})` : ''} : autorisez-la dans WHMCS (Sécurité › API IP Access Restriction)`,
      { action },
    );
  }
  if (/authentication failed|invalid or missing credentials|invalid (api )?credentials|access key/i.test(message)) {
    return new WhmcsApiError('auth', 'Identifiants API WHMCS refusés', { action });
  }
  if (/permission|not allowed|access denied/i.test(message)) {
    return new WhmcsApiError('permission', `Permission API WHMCS manquante pour l'action ${action}`, { action });
  }
  if (/not found/i.test(message)) return new WhmcsApiError('not_found', 'Élément introuvable dans WHMCS', { action });
  return new WhmcsApiError('other', `WHMCS a renvoyé une erreur pour l'action ${action}`, { action });
}

export interface CallOptions {
  /** Réglages à utiliser (test de connexion) ; par défaut ceux enregistrés. */
  settings?: WhmcsConfig;
  timeoutMs?: number;
}

type Params = Record<string, string | number | boolean | undefined>;

/**
 * Appelle une action de l'API WHMCS : POST application/x-www-form-urlencoded vers <url>/includes/api.php.
 * Les identifiants voyagent dans le corps (jamais dans l'URL), les redirections ne sont pas suivies
 * (un 3xx ferait partir les identifiants ailleurs) et le délai est borné.
 */
export async function whmcsCall(action: WhmcsAction, params: Params = {}, options: CallOptions = {}): Promise<Raw> {
  const settings = options.settings ?? requireWhmcsConfig();

  const form = new URLSearchParams();
  form.set('identifier', settings.identifier);
  form.set('secret', settings.secret);
  if (settings.accessKey) form.set('accesskey', settings.accessKey);
  form.set('action', action);
  form.set('responsetype', 'json');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) form.set(key, String(value));
  }

  const res = await upstreamFetch('whmcs', `${settings.url}/includes/api.php`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    redirect: 'error',
    timeoutMs: options.timeoutMs ?? 30_000,
  });

  // GetTransactions peut renvoyer tout l'historique d'un coup : plafond plus large que le défaut, mais borné.
  const raw = await readBodyLimited('whmcs', res, 4 * MAX_UPSTREAM_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }

  // WHMCS répond 403 avec un corps JSON { result: "error" } pour les refus d'authentification.
  if (isRecord(body) && body.result === 'error') throw toApiError(action, body.message);
  if (!res.ok) throw upstream('whmcs', `whmcs a répondu avec le statut ${res.status}`, { status: res.status, action });
  if (!isRecord(body) || body.result !== 'success') throw upstream('whmcs', 'Réponse illisible de whmcs', { action });
  return body;
}

export interface Collected {
  items: Raw[];
  /** Nombre total annoncé par WHMCS (au moins le nombre d'éléments lus). */
  total: number;
  /** true si le plafond de pages a été atteint avant la fin : les éléments les plus anciens manquent. */
  truncated: boolean;
}

export interface FetchAllOptions {
  pageSize?: number;
  maxPages?: number;
  /** Arrêt anticipé : appelé avec chaque page, retourne true quand il est inutile de lire la suite. */
  stopWhen?: (page: Raw[]) => boolean;
  timeoutMs?: number;
}

export const PAGE_SIZE = 250;
/** Plafond par défaut : 200 pages de 250 = 50 000 lignes par source. */
export const MAX_PAGES = 200;

/**
 * Lit toutes les pages d'une action paginée (`limitstart` = décalage en lignes, `limitnum`, `totalresults`).
 * Robuste aux serveurs qui ignorent la pagination (tout est renvoyé d'un coup, ou la même page en boucle) ou qui
 * plafonnent `limitnum` : on avance du nombre de lignes réellement reçues.
 */
export async function fetchAll(action: WhmcsAction, params: Params, container: string, item: string, options: FetchAllOptions = {}): Promise<Collected> {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const maxPages = options.maxPages ?? MAX_PAGES;
  const items: Raw[] = [];
  let total = 0;
  let previousFirstId: unknown;

  for (let page = 0; page < maxPages; page += 1) {
    const body = await whmcsCall(action, { ...params, limitstart: items.length, limitnum: pageSize }, { timeoutMs: options.timeoutMs });
    const rows = extractList(body, container, item);
    const reported = int(body.totalresults);
    total = Math.max(total, reported, items.length);
    if (rows.length === 0) return { items, total: Math.max(reported, items.length), truncated: false };

    const firstId = rows[0]?.id;
    if (page > 0 && firstId !== undefined && firstId === previousFirstId) {
      // Même page qu'au tour précédent : la pagination est ignorée, tout a déjà été lu.
      return { items, total: items.length, truncated: false };
    }
    previousFirstId = firstId;

    items.push(...rows);
    total = Math.max(total, items.length);
    if (rows.length > pageSize) return { items, total, truncated: false }; // `limitnum` ignoré : réponse complète
    if (options.stopWhen?.(rows)) return { items, total, truncated: false };
    if (reported > 0 ? items.length >= reported : rows.length < pageSize) return { items, total, truncated: false };
  }
  return { items, total, truncated: true };
}
