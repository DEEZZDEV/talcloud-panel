import type { WhmcsMonthlyPoint } from '@shared/api-types';
import { FileWarning, PiggyBank, ShoppingCart, TrendingUp, UserPlus, Users, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChartCard, ChartLegend, ChartSkeleton, SERIES_COLORS, TimeSeriesChart, type ChartSeries } from '@/components/shared/charts';
import { FadeIn, FilterChips, Page, PageHeader } from '@/components/shared/page';
import { StatCard, StatCardSkeleton } from '@/components/shared/stat-card';
import { EmptyState, ErrorState, NotConfiguredState, QueryBoundary } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useWhmcsMonthly, useWhmcsOverview } from '@/features/whmcs/api';
import { TruncatedNotice } from '@/features/whmcs/components';
import { isNotConfigured } from '@/lib/api';
import { formatMoney, formatMoneyCompact, formatMonth, formatNumber, plural } from '@/lib/format';

type Period = '6' | '12' | '24';
const PERIODS: { value: Period; label: string }[] = [
  { value: '6', label: '6 mois' },
  { value: '12', label: '12 mois' },
  { value: '24', label: '24 mois' },
];

const FINANCE_SERIES: ChartSeries<WhmcsMonthlyPoint>[] = [
  { key: 'revenue', label: "Chiffre d'affaires", color: SERIES_COLORS.revenue, type: 'area' },
  { key: 'costs', label: 'Coûts', color: SERIES_COLORS.costs, type: 'line' },
  { key: 'profit', label: 'Bénéfice net', color: SERIES_COLORS.profit, type: 'line' },
];
const CLIENT_SERIES: ChartSeries<WhmcsMonthlyPoint>[] = [{ key: 'newClients', label: 'Nouveaux clients', color: SERIES_COLORS.primary, type: 'bar' }];
const ORDER_SERIES: ChartSeries<WhmcsMonthlyPoint>[] = [{ key: 'orders', label: 'Commandes', color: SERIES_COLORS.primary, type: 'bar' }];

function Overview() {
  const overview = useWhmcsOverview();
  const monthly = useWhmcsMonthly(12);
  const points = monthly.data?.points ?? [];
  const trend = (key: keyof Omit<WhmcsMonthlyPoint, 'month'>) => (points.length > 1 ? points.map((point) => point[key]) : undefined);

  if (overview.data === undefined) {
    if (overview.isError) {
      return <Card>{isNotConfigured(overview.error) ? <NotConfiguredState integration="whmcs" /> : <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />}</Card>;
    }
    return (
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <StatCardSkeleton key={index} />
        ))}
      </div>
    );
  }

  const data = overview.data;
  const versus = 'vs mois précédent';
  const margin = data.revenue > 0 ? (data.netProfit / data.revenue) * 100 : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-3">
        <FadeIn index={0}>
          <StatCard label="Chiffre d'affaires" icon={TrendingUp} value={formatMoney(data.revenue, data.currency)} delta={data.deltas.revenue} hint={versus} trend={trend('revenue')} />
        </FadeIn>
        <FadeIn index={1}>
          <StatCard
            label="Bénéfice net"
            icon={Wallet}
            value={formatMoney(data.netProfit, data.currency)}
            delta={data.deltas.netProfit}
            hint={margin === null ? versus : `Marge ${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(margin)} %`}
            trend={trend('profit')}
          />
        </FadeIn>
        <FadeIn index={2}>
          <StatCard
            label="Coûts du mois"
            icon={PiggyBank}
            value={formatMoney(data.costs, data.currency)}
            hint={
              <Link to="/whmcs/costs" className="underline-offset-4 hover:text-foreground hover:underline">
                Gérer les coûts
              </Link>
            }
            trend={trend('costs')}
          />
        </FadeIn>
        <FadeIn index={3}>
          <StatCard label="Nouveaux clients" icon={UserPlus} value={formatNumber(data.newClients)} delta={data.deltas.newClients} hint={versus} trend={trend('newClients')} />
        </FadeIn>
        <FadeIn index={4}>
          <StatCard label="Commandes" icon={ShoppingCart} value={formatNumber(data.orders)} delta={data.deltas.orders} hint={versus} trend={trend('orders')} />
        </FadeIn>
        <FadeIn index={5}>
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
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Users className="size-3.5" aria-hidden />
        {formatNumber(data.activeClients)} clients actifs · chiffres de {formatMonth(data.month)} · les frais de passerelle sont inclus dans les coûts
      </p>
      {data.truncated ? <TruncatedNotice>Chiffres partiels : WHMCS contient plus de données que ce que le panel a pu parcourir ce mois-ci.</TruncatedNotice> : null}
    </div>
  );
}

export default function WhmcsDashboardPage() {
  const [period, setPeriod] = useState<Period>('12');
  const months = Number(period);
  const monthly = useWhmcsMonthly(months);
  const noHistory = <EmptyState compact icon={TrendingUp} title="Pas encore d'historique" description="Les graphiques apparaîtront dès les premières données WHMCS." />;
  const formatX = (value: string) => formatMonth(value, months > 12 ? 'short' : 'axis');

  return (
    <Page>
      <PageHeader
        title="WHMCS"
        description="Chiffre d'affaires, bénéfice net, clients et commandes."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link to="/whmcs/clients">Clients</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/whmcs/invoices">Factures</Link>
            </Button>
          </>
        }
      />

      <Overview />

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <h2 className="text-[15px] font-semibold">Évolution</h2>
        <FilterChips label="Période des graphiques" options={PERIODS} value={period} onChange={setPeriod} />
      </div>

      {monthly.data?.truncated ? <TruncatedNotice>Historique partiel : certains mois peuvent être sous-estimés.</TruncatedNotice> : null}

      <ChartCard title="Chiffre d'affaires, coûts et bénéfice" description={`${months} derniers mois`} legend={<ChartLegend series={FINANCE_SERIES} />}>
        <QueryBoundary query={monthly} integration="whmcs" compact skeleton={<ChartSkeleton height={320} />} isEmpty={(data) => data.points.length === 0} empty={noHistory}>
          {(data) => (
            <div className={monthly.isPlaceholderData ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
              <TimeSeriesChart
                data={data.points}
                xKey="month"
                series={FINANCE_SERIES}
                height={320}
                formatX={formatX}
                formatXLong={(value) => formatMonth(value)}
                formatValue={(value) => formatMoney(value, data.currency)}
                formatAxis={(value) => formatMoneyCompact(value, data.currency)}
                ariaLabel={`Chiffre d'affaires, coûts et bénéfice net par mois sur ${months} mois`}
              />
            </div>
          )}
        </QueryBoundary>
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Nouveaux clients" description="Inscriptions par mois">
          <QueryBoundary query={monthly} integration="whmcs" compact skeleton={<ChartSkeleton height={240} />} isEmpty={(data) => data.points.length === 0} empty={noHistory}>
            {(data) => (
              <TimeSeriesChart
                data={data.points}
                xKey="month"
                series={CLIENT_SERIES}
                height={240}
                formatX={formatX}
                formatXLong={(value) => formatMonth(value)}
                formatValue={formatNumber}
                allowDecimals={false}
                ariaLabel="Nouveaux clients par mois"
              />
            )}
          </QueryBoundary>
        </ChartCard>
        <ChartCard title="Commandes" description="Commandes passées par mois">
          <QueryBoundary query={monthly} integration="whmcs" compact skeleton={<ChartSkeleton height={240} />} isEmpty={(data) => data.points.length === 0} empty={noHistory}>
            {(data) => (
              <TimeSeriesChart
                data={data.points}
                xKey="month"
                series={ORDER_SERIES}
                height={240}
                formatX={formatX}
                formatXLong={(value) => formatMonth(value)}
                formatValue={formatNumber}
                allowDecimals={false}
                ariaLabel="Commandes par mois"
              />
            )}
          </QueryBoundary>
        </ChartCard>
      </div>
    </Page>
  );
}
