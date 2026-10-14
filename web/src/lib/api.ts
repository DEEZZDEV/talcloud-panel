import type { ApiErrorCode, IntegrationName, PageMeta, StepUpResponse } from '@shared/api-types';
import { isRecord } from '@/lib/utils';

/**
 * Client API unique du panel.
 *  - même origine, cookies de session (`credentials: 'same-origin'`) ;
 *  - jeton CSRF gardé en mémoire uniquement, envoyé sur toute requête hors GET ;
 *  - `X-TC-Background: 1` sur les rafraîchissements automatiques (ne prolongent pas la session) ;
 *  - 401 UNAUTHENTICATED → retour à la connexion ; 403 STEP_UP_REQUIRED → code TOTP demandé puis requête rejouée.
 */

export type ClientErrorCode = ApiErrorCode | 'NETWORK_ERROR' | 'STEP_UP_CANCELLED';

export class ApiError extends Error {
  constructor(
    public readonly code: ClientErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly status = 0,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Nom de l'intégration concernée (INTEGRATION_NOT_CONFIGURED, UPSTREAM_ERROR). */
  get integration(): IntegrationName | null {
    const value = isRecord(this.details) ? this.details.integration : null;
    return value === 'whmcs' || value === 'pterodactyl' || value === 'proxmox' || value === 'mail' || value === 'notifications' ? value : null;
  }

  /** Délai d'attente annoncé par le serveur (ACCOUNT_LOCKED). */
  get retryAfterSeconds(): number | null {
    const value = isRecord(this.details) ? this.details.retryAfterSeconds : null;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
  }

  /** La connexion en cours est perdue : revenir à la première étape. */
  get restart(): boolean {
    return isRecord(this.details) && this.details.restart === true;
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;
export const isNotConfigured = (error: unknown): error is ApiError => isApiError(error) && error.code === 'INTEGRATION_NOT_CONFIGURED';
/** L'utilisateur a fermé la demande de code 2FA : rien à signaler. */
export const isStepUpCancelled = (error: unknown): boolean => isApiError(error) && error.code === 'STEP_UP_CANCELLED';

export function errorMessage(error: unknown, fallback = 'Une erreur est survenue'): string {
  if (isApiError(error)) return error.message || fallback;
  return fallback;
}

// ───────────────────────────── État en mémoire ─────────────────────────────

let csrfToken: string | null = null;
let lastForegroundAt = Date.now();
let onUnauthenticated: (() => void) | null = null;
let onStepUpGranted: ((until: string) => void) | null = null;

export function setCsrfToken(token: string | null | undefined): void {
  csrfToken = token ?? null;
}
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}
export function setStepUpGrantedHandler(handler: ((until: string) => void) | null): void {
  onStepUpGranted = handler;
}
/** Instant de la dernière requête ayant prolongé la session côté serveur (tous onglets confondus). */
export const lastForegroundRequestAt = (): number => lastForegroundAt;

// Les onglets du panel partagent la même session : ils s'échangent uniquement l'horodatage de la dernière
// activité (aucune donnée), pour qu'un onglet inactif ne déconnecte pas un onglet en cours d'utilisation.
const activityChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('tc-activity');
if (activityChannel) {
  activityChannel.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data === 'number' && event.data > lastForegroundAt && event.data <= Date.now() + 5_000) lastForegroundAt = event.data;
  };
}
function markForeground(): void {
  lastForegroundAt = Date.now();
  try {
    activityChannel?.postMessage(lastForegroundAt);
  } catch {
    /* canal fermé : sans importance */
  }
}

// ───────────────────────────── Step-up centralisé ─────────────────────────────

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: ApiError) => void;
}

let pendingStepUp: Deferred | null = null;
const stepUpListeners = new Set<() => void>();
const emitStepUp = () => stepUpListeners.forEach((listener) => listener());

/** Ouvre (ou rejoint) la demande de code 2FA ; résout quand la re-confirmation a réussi. */
function ensureStepUp(): Promise<void> {
  if (!pendingStepUp) {
    let resolve!: () => void;
    let reject!: (error: ApiError) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Évite un rejet « non géré » si personne n'attend encore la promesse.
    promise.catch(() => undefined);
    pendingStepUp = { promise, resolve, reject };
    emitStepUp();
  }
  return pendingStepUp.promise;
}

/** Magasin observé par la boîte de dialogue globale (useSyncExternalStore). */
export const stepUpStore = {
  subscribe(listener: () => void): () => void {
    stepUpListeners.add(listener);
    return () => stepUpListeners.delete(listener);
  },
  isOpen: (): boolean => pendingStepUp !== null,
  /** Envoie le code TOTP ; en cas de succès, toutes les requêtes en attente sont rejouées. */
  async submit(totpCode: string): Promise<void> {
    const result = await send<StepUpResponse>('POST', '/api/auth/step-up', { body: { totpCode }, noStepUp: true });
    onStepUpGranted?.(result.data.stepUpUntil);
    const current = pendingStepUp;
    pendingStepUp = null;
    emitStepUp();
    current?.resolve();
  },
  cancel(error?: ApiError): void {
    const current = pendingStepUp;
    if (!current) return;
    pendingStepUp = null;
    emitStepUp();
    current.reject(error ?? new ApiError('STEP_UP_CANCELLED', 'Confirmation annulée', undefined, 403));
  },
};

// ───────────────────────────── Requêtes ─────────────────────────────

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  signal?: AbortSignal;
  /** Rafraîchissement automatique : ne prolonge pas la session. */
  background?: boolean;
  /** Ne pas ouvrir la demande de code 2FA (usage interne). */
  noStepUp?: boolean;
  /** Un 401 ne déclenche pas le retour à la connexion (lecture de l'état de session). */
  silentAuth?: boolean;
}

export interface ApiResult<T> {
  data: T;
  meta?: PageMeta;
}

export function buildUrl(path: string, query?: QueryParams): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

const FALLBACK_MESSAGES: Record<number, [ApiErrorCode, string]> = {
  400: ['VALIDATION_ERROR', 'Requête invalide'],
  401: ['UNAUTHENTICATED', 'Authentification requise'],
  403: ['FORBIDDEN', 'Action non autorisée'],
  404: ['NOT_FOUND', 'Ressource introuvable'],
  413: ['VALIDATION_ERROR', 'Contenu trop volumineux'],
  429: ['RATE_LIMITED', 'Trop de requêtes, réessayez plus tard'],
  502: ['UPSTREAM_ERROR', 'Le serveur du panel est injoignable'],
  503: ['UPSTREAM_ERROR', 'Le serveur du panel est momentanément indisponible'],
  504: ['UPSTREAM_ERROR', 'Le serveur du panel ne répond pas'],
};

async function send<T>(method: string, path: string, options: RequestOptions = {}, replayed = false): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (mutating && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (options.background) headers['X-TC-Background'] = '1';
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError('NETWORK_ERROR', 'Serveur injoignable. Vérifiez votre connexion.');
  }

  let payload: unknown = null;
  if (response.status !== 204) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  }

  if (response.ok) {
    if (!options.background) markForeground();
    if (isRecord(payload) && 'data' in payload) {
      const meta = isRecord(payload.meta) ? (payload.meta as unknown as PageMeta) : undefined;
      return { data: payload.data as T, meta };
    }
    if (response.status === 204) return { data: undefined as T };
    throw new ApiError('INTERNAL', 'Réponse inattendue du serveur', undefined, response.status);
  }

  let error: ApiError;
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === 'string') {
    const raw = payload.error;
    error = new ApiError(raw.code as ApiErrorCode, typeof raw.message === 'string' ? raw.message : 'Erreur', raw.details, response.status);
  } else {
    const [code, message] = FALLBACK_MESSAGES[response.status] ?? ['INTERNAL', 'Erreur interne du serveur'];
    error = new ApiError(code, message, undefined, response.status);
  }

  if (error.code === 'UNAUTHENTICATED') {
    if (!options.silentAuth) {
      stepUpStore.cancel(error);
      onUnauthenticated?.();
    }
    throw error;
  }

  if (error.code === 'STEP_UP_REQUIRED' && !options.noStepUp && !replayed) {
    await ensureStepUp();
    return send<T>(method, path, options, true);
  }

  throw error;
}

export const api = {
  /** GET → `data`. */
  get: async <T>(path: string, options?: RequestOptions): Promise<T> => (await send<T>('GET', path, options)).data,
  /** GET paginé → `{ data, meta }`. */
  getPage: <T>(path: string, options?: RequestOptions): Promise<ApiResult<T>> => send<T>('GET', path, options),
  /** POST → `data`. Sans corps, un objet vide est envoyé (le serveur attend toujours du JSON). */
  post: async <T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> => (await send<T>('POST', path, { ...options, body: body ?? {} })).data,
  put: async <T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> => (await send<T>('PUT', path, { ...options, body })).data,
  delete: async <T = unknown>(path: string, options?: RequestOptions): Promise<T> => (await send<T>('DELETE', path, options)).data,
};
