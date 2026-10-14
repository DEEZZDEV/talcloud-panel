import type { PanelNotification, ServerEvent, UnreadCount } from '@shared/api-types';
import { useQueryClient } from '@tanstack/react-query';
import { CreditCard, Info, ShieldAlert, ShoppingCart } from 'lucide-react';
import { createElement, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/auth-context';
import { orderData } from '@/features/notifications/api';
import { formatMoney } from '@/lib/format';
import { qk } from '@/lib/query';
import { isRecord } from '@/lib/utils';

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

function parseEvent(raw: unknown): ServerEvent | null {
  if (typeof raw !== 'string') return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    if (value.type === 'ping' || value.type === 'session_revoked') return { type: value.type };
    if (value.type === 'notification' && isRecord(value.notification) && typeof value.notification.id === 'number' && typeof value.notification.title === 'string') {
      return { type: 'notification', notification: value.notification as unknown as PanelNotification };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Flux temps réel `GET /api/events` (EventSource, même origine, cookie de session).
 *  - nouvelle notification → toast + compteur de non lus + listes rafraîchies ;
 *  - `session_revoked` → fermeture du flux et retour à la connexion ;
 *  - coupure → reconnexion avec temporisation croissante, après vérification de la session.
 */
export function useServerEvents(): void {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { signOut, refresh } = useAuth();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    let attempt = 0;
    let closed = false;

    const announce = (notification: PanelNotification) => {
      const order = orderData(notification);
      const open = () => navigateRef.current(`/notifications?open=${notification.id}`);
      const action = { label: 'Voir', onClick: open };
      if (order) {
        const paid = notification.type === 'payment';
        const details = [order.clientName, formatMoney(order.amount, order.currency), order.gatewayName ?? order.gateway].filter(Boolean).join(' · ');
        toast(paid ? 'Paiement reçu' : 'Nouvelle commande', {
          description: details,
          icon: createElement(paid ? CreditCard : ShoppingCart, { className: paid ? 'size-4 text-success' : 'size-4 text-info', 'aria-hidden': true }),
          duration: 9_000,
          action,
        });
        return;
      }
      const critical = notification.severity === 'critical' || notification.severity === 'warning';
      toast(notification.title, {
        description: notification.body || undefined,
        icon: createElement(notification.type === 'security' ? ShieldAlert : Info, {
          className: critical ? 'size-4 text-warning' : 'size-4 text-info',
          'aria-hidden': true,
        }),
        duration: critical ? 12_000 : 7_000,
        action,
      });
    };

    const onNotification = (notification: PanelNotification) => {
      if (!notification.read) client.setQueryData<UnreadCount>(qk.notifications.unread, (current) => ({ count: (current?.count ?? 0) + 1 }));
      void client.invalidateQueries({ queryKey: ['notifications', 'list'] });
      if (notification.type === 'order' || notification.type === 'payment') {
        // Une commande ou un paiement change les chiffres WHMCS affichés.
        void client.invalidateQueries({ queryKey: qk.whmcs.overview });
        void client.invalidateQueries({ queryKey: ['whmcs', 'orders'] });
        void client.invalidateQueries({ queryKey: ['whmcs', 'invoices'] });
      }
      announce(notification);
    };

    const connect = () => {
      if (closed) return;
      source = new EventSource('/api/events');
      source.onopen = () => {
        attempt = 0;
      };
      source.onmessage = (message: MessageEvent<unknown>) => {
        const event = parseEvent(message.data);
        if (!event) return;
        if (event.type === 'session_revoked') {
          closed = true;
          source?.close();
          void signOut('revoked', false);
        } else if (event.type === 'notification') {
          onNotification(event.notification);
        }
      };
      source.onerror = () => {
        // On gère nous-mêmes la reconnexion (temporisation, contrôle de session) plutôt que celle du navigateur.
        source?.close();
        source = null;
        if (closed) return;
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 30_000;
        attempt += 1;
        retryTimer = window.setTimeout(() => {
          // Si la session a expiré, `refresh` renvoie à la connexion et ce hook est démonté.
          void refresh(false).finally(connect);
        }, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [client, refresh, signOut]);
}
