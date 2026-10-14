import type { HomeBlockId, PanelNotification } from '@shared/api-types';
import { ArrowRight, BellOff, LayoutGrid, Boxes, CircleCheck, FileWarning, Gamepad2, Inbox, MailWarning, Server, ShoppingCart, TrendingUp, UserPlus, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChartCard, ChartLegend, ChartSkeleton, SERIES_COLORS, TimeSeriesChart, type ChartSeries } from '@/components/shared/charts';
import { FadeIn, Page, PageHeader } from '@/components/shared/page';
import { StatCard, StatCardSkeleton } from '@/components/shared/stat-card';
import { EmptyState, ErrorState, NotConfiguredState, QueryBoundary } from '@/components/shared/states';
import { StatusBadge, StatusDot } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { useMailUnreadSummary } from '@/features/mail/api';
import { DEFAULT_PREFERENCES, HOME_BLOCKS, layoutRows, usePreferences, type BlockRow } from '@/features/preferences/api';
import { useMarkRead, useNotifications } from '@/features/notifications/api';
import { NotificationRow } from '@/features/notifications/notification-item';
import { useProxmoxSummary } from '@/features/proxmox/api';
import { usePterodactylSummary } from '@/features/pterodactyl/api';
import { useWhmcsMonthly, useWhmcsOrders, useWhmcsOverview } from '@/features/whmcs/api';
import { ClientLink, TruncatedNotice } from '@/features/whmcs/components';
import { isNotConfigured } from '@/lib/api';
import { formatMoney, formatMoneyCompact, formatMonth, formatNumber, formatSmartDate, plural } from '@/lib/format';
import { orderStatus, paymentStatus } from '@/lib/status';
import { cn } from '@/lib/utils';
import type { WhmcsMonthlyPoint } from '@shared/api-types';

function BlockHeader({ title, description, to, linkLabel }: { title: string; description?: ReactNode; to?: string; linkLabel?: string }) {
  return (
    <CardHeader className="flex-row items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </div>
      {to ? (
        <Button asChild variant="subtle" size="sm" className="-mr-2 -mt-1.5 shrink-0">
          <Link to={to}>
            {linkLabel ?? 'Tout voir'}
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      ) : null}
    </CardHeader>
  );
}

function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className="divide-y" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <Skeleton className="h-4 w-16" />
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────────── Statistiques du mois ─────────────────────────────

function MonthStats() {
  const overview = useWhmcsOverview();
  const monthly = useWhmcsMonthly(12);
  const points = monthly.data?.points ?? [];
  const trend = (key: keyof Omit<WhmcsMonthlyPoint, 'month'>) => (points.length > 1 ? points.map((point) => point[key]) : undefined);

  if (overview.data === undefined) {
    if (overview.isError) {
      return (
        <Card>
          {isNotConfigured(overview.error) ? <NotConfiguredState integration="whmcs" compact /> : <ErrorState error={overview.error} compact onRetry={() => void overview.refetch()} />}
        </Card>
      );
    }
    return (
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <StatCardSkeleton key={index} className={index === 4 ? 'min-[480px]:col-span-2 xl:col-span-1' : undefined} />
        ))}
      </div>
    );
  }

  const data = overview.data;
  const versus = 'vs mois précédent';
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-5">
        <FadeIn index={0}>
          <StatCard label="Chiffre d'affaires" icon={TrendingUp} value={formatMoney(data.revenue, data.currency)} delta={data.deltas.revenue} hint={versus} trend={trend('revenue')} />
        </FadeIn>
        <FadeIn index={1}>
          <StatCard
            label="Bénéfice net"
            icon={Wallet}
            value={formatMoney(data.netProfit, data.currency)}
            delta={data.deltas.netProfit}
            hint={data.deltas.netProfit === null ? `Coûts : ${formatMoney(data.costs, data.currency)}` : versus}
            trend={trend('profit')}
          />
        </FadeIn>
        <FadeIn index={2}>
          <StatCard label="Nouveaux clients" icon={UserPlus} value={formatNumber(data.newClients)} delta={data.deltas.newClients} hint={`${formatNumber(data.activeClients)} actifs`} trend={trend('newClients')} />
        </FadeIn>
        <FadeIn index={3}>
          <StatCard label="Commandes" icon={ShoppingCart} value={formatNumber(data.orders)} delta={data.deltas.orders} hint={versus} trend={trend('orders')} />
        </FadeIn>
        <FadeIn index={4} className="min-[480px]:col-span-2 xl:col-span-1">
          <StatCard
            label="Impayés"
            icon={FileWarning}
            tone={data.unpaidInvoices.count > 0 ? 'warning' : 'default'}
            value={formatMoney(data.unpaidInvoices.total, data.currency)}
            hint={
              data.unpaidInvoices.count > 0 ? (
                <Link to="/whmcs/invoices?status=Unpaid" className="underline-offset-4 hover:text-foreground hover:underline">
                  {plural(data.unpaidInvoices.count, 'facture')} à encaisser
                </Link>
              ) : (
                'Aucune facture en attente'
              )
            }
          />
        </FadeIn>
      </div>
      {data.truncated ? <TruncatedNotice>Chiffres partiels : WHMCS contient plus de données que ce que le panel a pu parcourir ce mois-ci.</TruncatedNotice> : null}
    </div>
  );
}

// ───────────────────────────── Courbe CA / bénéfice ─────────────────────────────

const REVENUE_SERIES: ChartSeries<WhmcsMonthlyPoint>[] = [
  { key: 'revenue', label: "Chiffre d'affaires", color: SERIES_COLORS.revenue, type: 'area' },
  { key: 'profit', label: 'Bénéfice net', color: SERIES_COLORS.profit, type: 'line' },
];

function RevenueChart() {
  const monthly = useWhmcsMonthly(12);
  return (
    <ChartCard
      title="Chiffre d'affaires et bénéfice"
      description="12 derniers mois"
      legend={<ChartLegend series={REVENUE_SERIES} />}
      actions={
        <Button asChild variant="subtle" size="sm" className="-mr-2 hidden sm:inline-flex">
          <Link to="/whmcs">
            Détails
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      }
      className="h-full"
    >
      <QueryBoundary
        query={monthly}
        integration="whmcs"
        compact
        skeleton={<ChartSkeleton />}
        isEmpty={(data) => data.points.length === 0}
        empty={<EmptyState compact icon={TrendingUp} title="Pas encore d'historique" description="Les courbes apparaîtront dès les premières factures payées." />}
      >
        {(data) => (
          <TimeSeriesChart
            data={data.points}
            xKey="month"
            series={REVENUE_SERIES}
            formatX={(value) => formatMonth(value, 'axis')}
            formatXLong={(value) => formatMonth(value)}
            formatValue={(value) => formatMoney(value, data.currency)}
            formatAxis={(value) => formatMoneyCompact(value, data.currency)}
            ariaLabel="Chiffre d'affaires et bénéfice net par mois sur 12 mois"
          />
        )}
      </QueryBoundary>
    </ChartCard>
  );
}

// ───────────────────────────── Services hors ligne ─────────────────────────────

function ServiceGroup({ icon: Icon, title, to, children }: { icon: typeof Server; title: string; to: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 px-4 py-3.5 sm:px-5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-[13px] font-medium">
          <Icon className="size-4 text-subtle" aria-hidden />
          {title}
        </h4>
        <Link to={to} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Ouvrir
        </Link>
      </div>
      {children}
    </section>
  );
}

function AllGood({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
      {children}
    </p>
  );
}

function InlineState({ error, integration, onRetry }: { error: unknown; integration: 'pterodactyl' | 'proxmox'; onRetry: () => void }) {
  if (isNotConfigured(error)) {
    return (
      <p className="text-[13px] text-muted-foreground">
        Intégration non configurée.{' '}
        <Link to={`/settings#${integration}`} className="font-medium text-link underline-offset-4 hover:underline">
          Configurer
        </Link>
      </p>
    );
  }
  return (
    <p role="alert" className="text-[13px] text-danger">
      Données indisponibles.{' '}
      <button type="button" onClick={onRetry} className="font-medium underline underline-offset-4">
        Réessayer
      </button>
    </p>
  );
}

function OfflineServices() {
  const ptero = usePterodactylSummary();
  const proxmox = useProxmoxSummary();
  const lineSkeleton = (
    <div className="flex flex-col gap-2" aria-hidden>
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );

  return (
    <Card className="flex h-full flex-col">
      <BlockHeader title="Services hors ligne" description="Serveurs de jeu et infrastructure Proxmox" />
      <div className="flex flex-1 flex-col divide-y border-t">
        <ServiceGroup icon={Gamepad2} title="Serveurs de jeu" to="/servers">
          {ptero.data ? (
            ptero.data.offlineServers.length === 0 ? (
              <AllGood>
                {ptero.data.total === 0 ? 'Aucun serveur.' : `${formatNumber(ptero.data.running)} en ligne sur ${formatNumber(ptero.data.total)}${ptero.data.suspended ? ` · ${formatNumber(ptero.data.suspended)} suspendu${ptero.data.suspended > 1 ? 's' : ''}` : ''}`}
              </AllGood>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {plural(ptero.data.offlineServers.length, 'serveur')} hors ligne sur {formatNumber(ptero.data.total)}
                </p>
                <ul className="flex flex-col gap-1.5">
                  {ptero.data.offlineServers.slice(0, 5).map((server) => (
                    <li key={server.id} className="flex items-center gap-2 text-[13px]">
                      <StatusDot tone="danger" />
                      <span className="min-w-0 flex-1 truncate font-medium">{server.name}</span>
                      {server.node ? <span className="shrink-0 text-xs text-muted-foreground">{server.node}</span> : null}
                    </li>
                  ))}
                </ul>
                {ptero.data.offlineServers.length > 5 ? (
                  <Link to="/servers?status=offline" className="text-xs text-link underline-offset-4 hover:underline">
                    + {ptero.data.offlineServers.length - 5} autres
                  </Link>
                ) : null}
              </>
            )
          ) : ptero.isError ? (
            <InlineState error={ptero.error} integration="pterodactyl" onRetry={() => void ptero.refetch()} />
          ) : (
            lineSkeleton
          )}
        </ServiceGroup>

        <ServiceGroup icon={Boxes} title="Proxmox" to="/proxmox">
          {proxmox.data ? (
            <>
              {proxmox.data.offlineNodes.length === 0 ? (
                <AllGood>
                  {formatNumber(proxmox.data.nodes.online)} node{proxmox.data.nodes.online > 1 ? 's' : ''} en ligne sur {formatNumber(proxmox.data.nodes.total)}
                </AllGood>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {proxmox.data.offlineNodes.map((node) => (
                    <li key={node} className="flex items-center gap-2 text-[13px]">
                      <StatusDot tone="danger" />
                      <span className="min-w-0 flex-1 truncate font-medium">{node}</span>
                      <span className="shrink-0 text-xs text-danger">Node hors ligne</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <StatusDot tone={proxmox.data.guests.stopped > 0 ? 'neutral' : 'success'} className="mx-[5px]" />
                {formatNumber(proxmox.data.guests.running)} invité{proxmox.data.guests.running > 1 ? 's' : ''} en marche
                {proxmox.data.guests.stopped > 0 ? (
                  <>
                    {' · '}
                    <Link to="/proxmox?status=stopped" className="text-foreground underline-offset-4 hover:underline">
                      {formatNumber(proxmox.data.guests.stopped)} arrêté{proxmox.data.guests.stopped > 1 ? 's' : ''}
                    </Link>
                  </>
                ) : null}
              </p>
            </>
          ) : proxmox.isError ? (
            <InlineState error={proxmox.error} integration="proxmox" onRetry={() => void proxmox.refetch()} />
          ) : (
            lineSkeleton
          )}
        </ServiceGroup>
      </div>
    </Card>
  );
}

// ───────────────────────────── Dernières commandes ─────────────────────────────

function RecentOrders() {
  const orders = useWhmcsOrders({ page: 1, pageSize: 6 });
  return (
    <Card className="flex h-full flex-col">
      <BlockHeader title="Dernières commandes" to="/whmcs/orders" />
      <div className="flex-1 border-t">
        <QueryBoundary
          query={orders}
          integration="whmcs"
          compact
          skeleton={<RowsSkeleton rows={6} />}
          isEmpty={(data) => data.items.length === 0}
          empty={<EmptyState compact icon={ShoppingCart} title="Aucune commande pour l'instant" description="Les nouvelles commandes WHMCS s'afficheront ici en temps réel." />}
        >
          {(data) => (
            <ul className="divide-y">
              {data.items.map((order) => {
                const payment = order.paymentStatus ? paymentStatus(order.paymentStatus) : orderStatus(order.status);
                return (
                  <li key={order.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <ClientLink id={order.clientId} name={order.clientName} className="truncate text-[13px]" />
                      <p className="truncate text-xs text-muted-foreground">
                        {order.products.length > 0 ? order.products.join(', ') : `Commande n° ${order.orderNumber}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="tabular text-[13px] font-semibold">{formatMoney(order.amount, order.currency)}</span>
                      <span className="flex items-center gap-2">
                        <span className="tabular hidden text-xs text-muted-foreground sm:inline">{formatSmartDate(order.date)}</span>
                        <StatusBadge status={payment} />
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryBoundary>
      </div>
    </Card>
  );
}

// ───────────────────────────── Mails non lus ─────────────────────────────

function UnreadMail() {
  const summary = useMailUnreadSummary();
  return (
    <Card className="flex h-full flex-col">
      <BlockHeader title="Mails non lus" description={summary.data ? `${formatNumber(summary.data.total)} au total` : 'Par boîte'} to="/mail" linkLabel="Ouvrir" />
      <div className="flex-1 border-t">
        <QueryBoundary
          query={summary}
          integration="mail"
          compact
          skeleton={<RowsSkeleton rows={3} />}
          isEmpty={(data) => data.accounts.length === 0}
          empty={
            <EmptyState
              compact
              icon={Inbox}
              title="Aucune boîte mail"
              description="Ajoutez vos comptes (support, contact, facturation…) pour lire et répondre depuis le panel."
              action={
                <Button asChild size="sm">
                  <Link to="/settings#mail">Ajouter un compte</Link>
                </Button>
              }
            />
          }
        >
          {(data) => (
            <ul className="divide-y">
              {data.accounts.map((account) => (
                <li key={account.accountId}>
                  <Link to={`/mail?account=${account.accountId}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 sm:px-5">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground">
                      {account.error ? <MailWarning className="size-4 text-warning" aria-hidden /> : <Inbox className="size-4" aria-hidden />}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[13px] font-medium">{account.label}</span>
                      <span className="truncate text-xs text-muted-foreground">{account.error ?? account.address}</span>
                    </span>
                    {account.error ? null : account.unread > 0 ? (
                      <span className="tabular inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-primary/15 px-2 text-xs font-semibold text-link">
                        {formatNumber(account.unread)}
                        <span className="sr-only"> non lus</span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">À jour</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </div>
    </Card>
  );
}

// ───────────────────────────── Dernières notifications ─────────────────────────────

function RecentNotifications() {
  const navigate = useNavigate();
  const notifications = useNotifications({ type: 'all', unreadOnly: false, page: 1, pageSize: 6 });
  const markRead = useMarkRead();
  const select = (notification: PanelNotification) => {
    if (!notification.read) markRead.mutate(notification.id);
    navigate(`/notifications?open=${notification.id}`);
  };
  return (
    <Card>
      <BlockHeader title="Dernières notifications" to="/notifications" />
      <div className="border-t">
        <QueryBoundary
          query={notifications}
          integration="notifications"
          compact
          skeleton={<RowsSkeleton rows={4} />}
          isEmpty={(data) => data.items.length === 0}
          empty={<EmptyState compact icon={BellOff} title="Rien à signaler" description="Commandes, paiements et alertes de sécurité apparaîtront ici." />}
        >
          {(data) => (
            <ul className="divide-y">
              {data.items.map((notification) => (
                <li key={notification.id}>
                  <NotificationRow notification={notification} onSelect={select} dense />
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </div>
    </Card>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 5 || hour >= 18 ? 'Bonsoir' : 'Bonjour';
}

/** Accueil : chaque bloc charge, échoue ou signale une intégration manquante indépendamment des autres. */
const BLOCK_COMPONENTS: Record<HomeBlockId, () => ReactNode> = {
  stats: () => <MonthStats />,
  revenueChart: () => <RevenueChart />,
  recentOrders: () => <RecentOrders />,
  mail: () => <UnreadMail />,
  offlineServices: () => <OfflineServices />,
  notifications: () => <RecentNotifications />,
};

/** Rangée de blocs : pleine largeur, ou deux blocs côte à côte (2/3 – 1/3 ou moitié – moitié) sur grand écran. */
function Row({ row }: { row: BlockRow }) {
  if (row.kind === 'single') return <section aria-label={HOME_BLOCKS[row.block].label}>{BLOCK_COMPONENTS[row.block]()}</section>;
  const [first, second] = row.blocks;
  const span = (block: HomeBlockId) => (HOME_BLOCKS[block].width === 'wide' ? 'xl:col-span-2' : 'xl:col-span-1');
  const equal = HOME_BLOCKS[first].width === HOME_BLOCKS[second].width;
  return (
    <div className={cn('grid grid-cols-1 gap-4', equal ? 'xl:grid-cols-2' : 'xl:grid-cols-3')}>
      <section aria-label={HOME_BLOCKS[first].label} className={equal ? undefined : span(first)}>
        {BLOCK_COMPONENTS[first]()}
      </section>
      <section aria-label={HOME_BLOCKS[second].label} className={equal ? undefined : span(second)}>
        {BLOCK_COMPONENTS[second]()}
      </section>
    </div>
  );
}

function BlocksSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy aria-label="Chargement de l'accueil">
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <StatCardSkeleton key={index} />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}

/**
 * Accueil : les blocs affichés et leur ordre suivent les préférences du compte connecté. Chaque bloc charge, échoue ou
 * signale une intégration manquante indépendamment des autres.
 */
export default function HomePage() {
  const { user } = useAuth();
  const preferences = usePreferences();
  // Préférences illisibles (erreur réseau) : l'accueil par défaut plutôt qu'une page vide.
  const blocks = preferences.data?.home.blocks ?? (preferences.isError ? DEFAULT_PREFERENCES.home.blocks : null);
  const overview = useWhmcsOverview(blocks?.includes('stats') ?? false);
  const formatted = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const today = formatted.charAt(0).toUpperCase() + formatted.slice(1);
  return (
    <Page>
      <PageHeader
        title={`${greeting()}${user ? `, ${user.username}` : ''}`}
        description={
          <>
            {today}
            {overview.data ? ` · activité de ${formatMonth(overview.data.month)}` : null}
          </>
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/settings#mon-espace">
              <LayoutGrid aria-hidden />
              Personnaliser
            </Link>
          </Button>
        }
      />
      {blocks === null ? (
        <BlocksSkeleton />
      ) : blocks.length === 0 ? (
        <Card>
          <EmptyState
            icon={LayoutGrid}
            title="Votre accueil est vide"
            description="Tous les blocs sont masqués. Choisissez ceux à afficher, et leur ordre, dans Réglages › Mon espace."
            action={
              <Button asChild size="sm">
                <Link to="/settings#mon-espace">Choisir les blocs</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        layoutRows(blocks).map((row) => <Row key={row.kind === 'single' ? row.block : row.blocks.join('+')} row={row} />)
      )}
    </Page>
  );
}
