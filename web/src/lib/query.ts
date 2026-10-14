import { keepPreviousData, QueryClient, type QueryFunctionContext } from '@tanstack/react-query';
import type { PageMeta } from '@shared/api-types';
import { api, isApiError, type ApiResult, type QueryParams } from '@/lib/api';

/** Aucune persistance : le cache React Query vit en mémoire et disparaît à la déconnexion. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry(failureCount, error) {
        // Les erreurs « métier » (4xx, intégration non configurée, API distante en panne) ne sont pas retentées.
        if (isApiError(error) && error.code !== 'NETWORK_ERROR' && error.code !== 'INTERNAL') return false;
        return failureCount < 1;
      },
    },
    mutations: { retry: false },
  },
});

/**
 * Seul le tout premier chargement d'une requête (jamais exécutée : ni succès, ni échec, ni nouvel essai) est
 * considéré comme une action de l'utilisateur. Toute autre exécution — intervalle de rafraîchissement, retour sur
 * l'onglet, reconnexion, invalidation, nouvel essai après une erreur (intégration non configurée → 409, API
 * distante en panne → 502) — part avec `X-TC-Background: 1` et ne prolonge donc jamais la session.
 * L'activité réelle (clavier, souris, toucher) est signalée séparément par `IdleGuard`.
 */
const isRefresh = (context: QueryFunctionContext): boolean => {
  const state = context.client.getQueryState(context.queryKey);
  if (!state) return false;
  return state.data !== undefined || state.dataUpdateCount + state.errorUpdateCount > 0 || state.fetchFailureCount > 0;
};

/** queryFn → `data`. */
export const fetcher =
  <T>(path: string, query?: QueryParams) =>
  (context: QueryFunctionContext): Promise<T> =>
    api.get<T>(path, { query, signal: context.signal, background: isRefresh(context) });

export interface Page<T> {
  items: T[];
  /** `truncated` : la recherche distante n'a pas pu couvrir toutes les données. */
  meta: PageMeta & { truncated?: boolean };
}

/** queryFn → `{ items, meta }` pour les listes paginées. */
export const pageFetcher =
  <T>(path: string, query?: QueryParams) =>
  async (context: QueryFunctionContext): Promise<Page<T>> => {
    const result: ApiResult<T[]> = await api.getPage<T[]>(path, { query, signal: context.signal, background: isRefresh(context) });
    const items = Array.isArray(result.data) ? result.data : [];
    return { items, meta: result.meta ?? { page: Number(query?.page ?? 1), pageSize: Number(query?.pageSize ?? items.length), total: items.length } };
  };

export { keepPreviousData };

/** Clés de requêtes structurées : [domaine, ressource, paramètres]. */
export const qk = {
  whmcs: {
    all: ['whmcs'] as const,
    overview: ['whmcs', 'overview'] as const,
    monthly: (months: number) => ['whmcs', 'monthly', months] as const,
    clients: (params: QueryParams) => ['whmcs', 'clients', params] as const,
    client: (id: number) => ['whmcs', 'client', id] as const,
    orders: (params: QueryParams) => ['whmcs', 'orders', params] as const,
    invoices: (params: QueryParams) => ['whmcs', 'invoices', params] as const,
    costs: ['whmcs', 'costs'] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    list: (params: QueryParams) => ['notifications', 'list', params] as const,
    unread: ['notifications', 'unread-count'] as const,
  },
  push: { key: ['push', 'public-key'] as const },
  mail: {
    all: ['mail'] as const,
    accounts: ['mail', 'accounts'] as const,
    summary: ['mail', 'unread-summary'] as const,
    folders: (accountId: number) => ['mail', 'folders', accountId] as const,
    messagesRoot: (accountId: number) => ['mail', 'messages', accountId] as const,
    messages: (accountId: number, params: QueryParams) => ['mail', 'messages', accountId, params] as const,
    message: (accountId: number, folder: string, uid: number) => ['mail', 'message', accountId, folder, uid] as const,
  },
  pterodactyl: {
    all: ['pterodactyl'] as const,
    servers: ['pterodactyl', 'servers'] as const,
    summary: ['pterodactyl', 'summary'] as const,
  },
  proxmox: {
    all: ['proxmox'] as const,
    nodes: ['proxmox', 'nodes'] as const,
    guests: ['proxmox', 'guests'] as const,
    summary: ['proxmox', 'summary'] as const,
    history: (node: string, timeframe: string) => ['proxmox', 'history', node, timeframe] as const,
  },
  security: {
    all: ['security'] as const,
    sessions: ['security', 'sessions'] as const,
    devices: ['security', 'devices'] as const,
    audit: (params: QueryParams) => ['security', 'audit', params] as const,
    allowlist: ['security', 'ip-allowlist'] as const,
    backupCodes: ['security', 'backup-codes'] as const,
  },
  settings: (namespace: string) => ['settings', namespace] as const,
};
