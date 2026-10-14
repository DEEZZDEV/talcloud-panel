import type { Cost, CostInput, WhmcsClient, WhmcsClientDetail, WhmcsInvoice, WhmcsMonthlyStats, WhmcsOrder, WhmcsOverview } from '@shared/api-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type QueryParams } from '@/lib/api';
import { fetcher, keepPreviousData, pageFetcher, qk } from '@/lib/query';

/** Le serveur ajoute `truncated` quand WHMCS contient plus de données que ce qui a pu être parcouru. */
export type Truncatable<T> = T & { truncated?: boolean };

export interface ListParams {
  search?: string;
  status?: string;
  page: number;
  pageSize: number;
}

const toQuery = (params: ListParams): QueryParams => ({
  search: params.search?.trim() || undefined,
  status: params.status && params.status !== 'all' ? params.status : undefined,
  page: params.page,
  pageSize: params.pageSize,
});

export const useWhmcsOverview = () =>
  useQuery({ queryKey: qk.whmcs.overview, queryFn: fetcher<Truncatable<WhmcsOverview>>('/api/whmcs/stats/overview'), staleTime: 60_000, refetchInterval: 5 * 60_000 });

export const useWhmcsMonthly = (months = 12) =>
  useQuery({ queryKey: qk.whmcs.monthly(months), queryFn: fetcher<Truncatable<WhmcsMonthlyStats>>('/api/whmcs/stats/monthly', { months }), staleTime: 5 * 60_000, placeholderData: keepPreviousData });

export function useWhmcsClients(params: ListParams, enabled = true) {
  const query = toQuery(params);
  return useQuery({ queryKey: qk.whmcs.clients(query), queryFn: pageFetcher<WhmcsClient>('/api/whmcs/clients', query), placeholderData: keepPreviousData, staleTime: 60_000, enabled });
}

export const useWhmcsClient = (id: number | null) =>
  useQuery({
    queryKey: qk.whmcs.client(id ?? 0),
    queryFn: fetcher<WhmcsClientDetail>(`/api/whmcs/clients/${encodeURIComponent(String(id))}`),
    enabled: id !== null && Number.isInteger(id) && id > 0,
    staleTime: 60_000,
  });

export function useWhmcsOrders(params: ListParams) {
  const query = toQuery(params);
  return useQuery({ queryKey: qk.whmcs.orders(query), queryFn: pageFetcher<WhmcsOrder>('/api/whmcs/orders', query), placeholderData: keepPreviousData, staleTime: 30_000 });
}

export function useWhmcsInvoices(params: ListParams) {
  const query = toQuery(params);
  return useQuery({ queryKey: qk.whmcs.invoices(query), queryFn: pageFetcher<WhmcsInvoice>('/api/whmcs/invoices', query), placeholderData: keepPreviousData, staleTime: 30_000 });
}

export const useCosts = () => useQuery({ queryKey: qk.whmcs.costs, queryFn: fetcher<Cost[]>('/api/whmcs/costs'), staleTime: 60_000 });

/** Après une modification des coûts : la liste, mais aussi le bénéfice (vue d'ensemble et courbes). */
function useInvalidateCosts() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: qk.whmcs.costs });
    void client.invalidateQueries({ queryKey: qk.whmcs.overview });
    void client.invalidateQueries({ queryKey: ['whmcs', 'monthly'] });
  };
}

export function useSaveCost() {
  const invalidate = useInvalidateCosts();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: CostInput }) =>
      id === null ? api.post<Cost>('/api/whmcs/costs', input) : api.put<Cost>(`/api/whmcs/costs/${encodeURIComponent(String(id))}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteCost() {
  const invalidate = useInvalidateCosts();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/api/whmcs/costs/${encodeURIComponent(String(id))}`),
    onSuccess: invalidate,
  });
}
