import type { NotificationType, PanelNotification } from '@shared/api-types';
import { CreditCard, Info, ShieldAlert, ShoppingCart, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DetailRow } from '@/components/shared/misc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { orderData } from '@/features/notifications/api';
import { formatDateTime, formatMoney, formatRelative } from '@/lib/format';
import { notificationTypeLabel, severityTone, type Tone } from '@/lib/status';
import { cn } from '@/lib/utils';

const TYPE_ICON: Record<NotificationType, LucideIcon> = { order: ShoppingCart, payment: CreditCard, security: ShieldAlert, system: Info };

const ICON_TONE: Record<Tone, string> = {
  success: 'border-success/20 bg-success/10 text-success',
  warning: 'border-warning/25 bg-warning/10 text-warning',
  danger: 'border-danger/25 bg-danger/10 text-danger',
  info: 'border-info/25 bg-info/10 text-info',
  neutral: 'bg-muted text-muted-foreground',
};

export function NotificationIcon({ notification, className }: { notification: PanelNotification; className?: string }) {
  const Icon = TYPE_ICON[notification.type] ?? Info;
  const tone = severityTone[notification.severity] ?? 'neutral';
  return (
    <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full border', ICON_TONE[tone], className)}>
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

/** Ligne de notification (cloche, accueil, centre de notifications). Le contenu vient de l'API : rendu en texte seulement. */
export function NotificationRow({ notification, onSelect, dense }: { notification: PanelNotification; onSelect: (notification: PanelNotification) => void; dense?: boolean }) {
  const order = orderData(notification);
  return (
    <button
      type="button"
      onClick={() => onSelect(notification)}
      className={cn('group flex w-full items-start gap-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50', dense ? 'px-4 py-3' : 'px-4 py-3.5 sm:px-5')}
    >
      <NotificationIcon notification={notification} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline justify-between gap-3">
          <span className={cn('truncate text-[13px]', notification.read ? 'font-medium text-foreground/85' : 'font-semibold')}>{notification.title}</span>
          <span className="tabular shrink-0 text-xs text-muted-foreground">{formatRelative(notification.createdAt)}</span>
        </span>
        <span className={cn('text-[13px] leading-snug text-muted-foreground', dense ? 'line-clamp-1' : 'line-clamp-2')}>
          {order ? [order.clientName, order.products.slice(0, 2).join(', ')].filter(Boolean).join(' — ') || notification.body : notification.body}
        </span>
        {order && !dense ? (
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone="outline" className="tabular">
              {formatMoney(order.amount, order.currency)}
            </Badge>
            {order.gatewayName ?? order.gateway ? <Badge>{order.gatewayName ?? order.gateway}</Badge> : null}
          </span>
        ) : null}
      </span>
      <span className="flex w-2 shrink-0 justify-center pt-2">
        {notification.read ? null : (
          <>
            <span aria-hidden className="size-2 rounded-full bg-primary" />
            <span className="sr-only">Non lue</span>
          </>
        )}
      </span>
    </button>
  );
}

const EVENT_LABEL = { order_created: 'Nouvelle commande', invoice_paid: 'Facture payée', order_paid: 'Commande payée' } as const;

/** Détail d'une notification ; pour une commande ou un paiement : client, produits, montant, moyen de paiement, compte qui encaisse. */
export function NotificationDetail({ notification, onNavigate }: { notification: PanelNotification; onNavigate?: () => void }) {
  const order = orderData(notification);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <NotificationIcon notification={notification} className="size-10" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[15px] font-semibold leading-snug">{notification.title}</p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Badge>{notificationTypeLabel[notification.type] ?? notification.type}</Badge>
            <span>{formatDateTime(notification.createdAt)}</span>
          </p>
        </div>
      </div>

      {notification.body ? <p className="whitespace-pre-line break-words text-[13px] leading-relaxed text-muted-foreground">{notification.body}</p> : null}

      {order ? (
        <>
          <div className="rounded-xl border bg-muted/40 p-4">
            <p className="text-xs font-medium text-muted-foreground">{EVENT_LABEL[order.event]}</p>
            <p className="mt-1 text-[28px] font-semibold leading-none tracking-tight">{formatMoney(order.amount, order.currency)}</p>
          </div>

          <dl className="divide-y">
            <DetailRow label="Client">
              {order.clientId ? (
                <Link to={`/whmcs/clients/${order.clientId}`} onClick={onNavigate} className="text-link underline-offset-4 hover:underline">
                  {order.clientName}
                </Link>
              ) : (
                order.clientName
              )}
            </DetailRow>
            {order.clientEmail ? <DetailRow label="E-mail">{order.clientEmail}</DetailRow> : null}
            <DetailRow label="Moyen de paiement">{order.gatewayName ?? order.gateway ?? '—'}</DetailRow>
            <DetailRow label="Compte qui encaisse">
              {order.receivingAccount ?? <span className="font-normal text-muted-foreground">Non associé</span>}
            </DetailRow>
            {order.orderId ? <DetailRow label="Commande">#{order.orderId}</DetailRow> : null}
            {order.invoiceId ? <DetailRow label="Facture">#{order.invoiceId}</DetailRow> : null}
            {order.transactionId ? (
              <DetailRow label="Transaction">
                <span className="font-mono text-xs">{order.transactionId}</span>
              </DetailRow>
            ) : null}
          </dl>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">Produits</p>
            {order.products.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {order.products.map((product, index) => (
                  <li key={index} className="rounded-lg border bg-card px-3 py-2 text-[13px]">
                    {product}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">Aucun produit détaillé.</p>
            )}
          </div>

          {!order.receivingAccount && order.gateway ? (
            <>
              <Separator />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Associez la passerelle « {order.gateway} » à un compte dans{' '}
                <Link to="/settings#notifications" onClick={onNavigate} className="text-link underline-offset-4 hover:underline">
                  Réglages › Notifications
                </Link>{' '}
                pour savoir quel compte encaisse.
              </p>
            </>
          ) : null}
        </>
      ) : notification.type === 'security' ? (
        <Button asChild variant="outline" size="sm" className="self-start">
          <Link to="/security" onClick={onNavigate}>
            Ouvrir la page Sécurité
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
