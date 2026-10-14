import type { NotificationType, OrderNotificationData, PanelNotification, UnreadCount } from '@shared/api-types';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type QueryParams } from '@/lib/api';
import { fetcher, keepPreviousData, pageFetcher, qk, type Page } from '@/lib/query';
import { isRecord } from '@/lib/utils';

export interface NotificationFilters {
  type: NotificationType | 'all';
  unreadOnly: boolean;
  page: number;
  pageSize: number;
}

const toQuery = (filters: NotificationFilters): QueryParams => ({
  type: filters.type === 'all' ? undefined : filters.type,
  unread: filters.unreadOnly ? 1 : undefined,
  page: filters.page,
  pageSize: filters.pageSize,
});

export function useNotifications(filters: NotificationFilters, enabled = true) {
  const query = toQuery(filters);
  return useQuery({
    queryKey: qk.notifications.list(query),
    queryFn: pageFetcher<PanelNotification>('/api/notifications', query),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    enabled,
  });
}

/** Compteur de non lus : tenu à jour par le flux temps réel, avec une interrogation de secours espacée. */
export const useUnreadCount = () =>
  useQuery({ queryKey: qk.notifications.unread, queryFn: fetcher<UnreadCount>('/api/notifications/unread-count'), staleTime: 30_000, refetchInterval: 2 * 60_000 });

/** Applique « lu » dans toutes les listes en cache, sans attendre le serveur. */
function patchLists(client: QueryClient, update: (notification: PanelNotification) => PanelNotification): void {
  client.setQueriesData<Page<PanelNotification>>({ queryKey: ['notifications', 'list'] }, (page) => (page ? { ...page, items: page.items.map(update) } : page));
}

export function useMarkRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post(`/api/notifications/${encodeURIComponent(String(id))}/read`),
    onMutate: (id) => {
      patchLists(client, (notification) => (notification.id === id ? { ...notification, read: true } : notification));
      client.setQueryData<UnreadCount>(qk.notifications.unread, (current) => (current ? { count: Math.max(0, current.count - 1) } : current));
    },
    onSettled: () => void client.invalidateQueries({ queryKey: qk.notifications.all }),
  });
}

export function useMarkAllRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/api/notifications/read-all'),
    onMutate: () => {
      patchLists(client, (notification) => ({ ...notification, read: true }));
      client.setQueryData<UnreadCount>(qk.notifications.unread, { count: 0 });
    },
    onSettled: () => void client.invalidateQueries({ queryKey: qk.notifications.all }),
  });
}

/** Les données d'une notification viennent du serveur mais sont typées largement : on vérifie leur forme avant usage. */
export function orderData(notification: PanelNotification): OrderNotificationData | null {
  const data = notification.data;
  if (notification.type !== 'order' && notification.type !== 'payment') return null;
  if (!isRecord(data) || typeof data.clientName !== 'string' || typeof data.amount !== 'number' || typeof data.currency !== 'string') return null;
  return {
    event: data.event === 'invoice_paid' || data.event === 'order_paid' ? data.event : 'order_created',
    orderId: typeof data.orderId === 'number' ? data.orderId : undefined,
    invoiceId: typeof data.invoiceId === 'number' ? data.invoiceId : undefined,
    clientId: typeof data.clientId === 'number' ? data.clientId : undefined,
    clientName: data.clientName,
    clientEmail: typeof data.clientEmail === 'string' ? data.clientEmail : undefined,
    products: Array.isArray(data.products) ? data.products.filter((product): product is string => typeof product === 'string') : [],
    amount: data.amount,
    currency: data.currency,
    gateway: typeof data.gateway === 'string' ? data.gateway : null,
    gatewayName: typeof data.gatewayName === 'string' ? data.gatewayName : null,
    receivingAccount: typeof data.receivingAccount === 'string' ? data.receivingAccount : null,
    transactionId: typeof data.transactionId === 'string' ? data.transactionId : undefined,
  };
}
