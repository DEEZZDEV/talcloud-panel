import type { GuestAction, GuestActionRequest, GuestActionResult, ProxmoxGuest, ProxmoxNode, ProxmoxNodeHistoryPoint, ProxmoxSummary } from '@shared/api-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fetcher, keepPreviousData, qk } from '@/lib/query';

export type Timeframe = 'hour' | 'day' | 'week';

export const useProxmoxNodes = () => useQuery({ queryKey: qk.proxmox.nodes, queryFn: fetcher<ProxmoxNode[]>('/api/proxmox/nodes'), staleTime: 10_000, refetchInterval: 20_000 });

export const useProxmoxGuests = () => useQuery({ queryKey: qk.proxmox.guests, queryFn: fetcher<ProxmoxGuest[]>('/api/proxmox/guests'), staleTime: 10_000, refetchInterval: 20_000 });

export const useProxmoxSummary = () =>
  useQuery({ queryKey: qk.proxmox.summary, queryFn: fetcher<ProxmoxSummary>('/api/proxmox/summary'), staleTime: 30_000, refetchInterval: 60_000 });

export const useNodeHistory = (node: string, timeframe: Timeframe, enabled = true) =>
  useQuery({
    queryKey: qk.proxmox.history(node, timeframe),
    queryFn: fetcher<ProxmoxNodeHistoryPoint[]>(`/api/proxmox/nodes/${encodeURIComponent(node)}/history`, { timeframe }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchInterval: timeframe === 'hour' ? 60_000 : 5 * 60_000,
  });

export function useGuestAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ guest, action }: { guest: ProxmoxGuest; action: GuestAction }) =>
      api.post<GuestActionResult>(
        `/api/proxmox/guests/${encodeURIComponent(guest.node)}/${encodeURIComponent(guest.type)}/${encodeURIComponent(String(guest.vmid))}/action`,
        { action } satisfies GuestActionRequest,
      ),
    onSuccess: () => {
      // La tâche Proxmox est asynchrone : on relit l'état après un court délai, puis une seconde fois.
      const invalidate = () => void client.invalidateQueries({ queryKey: qk.proxmox.all });
      window.setTimeout(invalidate, 2_000);
      window.setTimeout(invalidate, 8_000);
    },
  });
}
