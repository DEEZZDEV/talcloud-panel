import type { GuestAction, ProxmoxGuest, ProxmoxNode, ProxmoxNodeHistoryPoint } from '@shared/api-types';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { Activity, Box, Boxes, Cpu, HardDrive, MemoryStick, Monitor, MoreHorizontal, Play, Power, RotateCw, SearchX, ServerOff, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ChartLegend, ChartSkeleton, SERIES_COLORS, TimeSeriesChart, type ChartSeries } from '@/components/shared/charts';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DataTable, DataTableSkeleton, type Column } from '@/components/shared/data-table';
import { Meter, ratio } from '@/components/shared/meter';
import { FadeIn, FilterChips, Page, PageHeader, RefreshButton, SearchInput } from '@/components/shared/page';
import { EmptyState, ErrorState, QueryBoundary } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Hint } from '@/components/ui/tooltip';
import { useGuestAction, useNodeHistory, useProxmoxGuests, useProxmoxNodes, type Timeframe } from '@/features/proxmox/api';
import { errorMessage, isStepUpCancelled } from '@/lib/api';
import { formatBytes, formatDuration, formatNumber, formatPercent } from '@/lib/format';
import { guestStatus, nodeStatus } from '@/lib/status';
import { cn } from '@/lib/utils';

const TIMEFRAMES: { value: Timeframe; label: string }[] = [
  { value: 'hour', label: '1 heure' },
  { value: 'day', label: '24 heures' },
  { value: 'week', label: '7 jours' },
];

const HISTORY_SERIES: ChartSeries<ProxmoxNodeHistoryPoint>[] = [
  { key: 'cpuPercent', label: 'CPU', color: SERIES_COLORS.revenue, type: 'area' },
  { key: 'memoryPercent', label: 'Mémoire', color: SERIES_COLORS.costs, type: 'line' },
];

const formatTick = (timeframe: Timeframe) => (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return format(date, timeframe === 'week' ? 'EEE d' : 'HH:mm', { locale: fr });
};
const formatPoint = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : format(date, "EEEE d MMM 'à' HH:mm", { locale: fr });
};

// ───────────────────────────── Nodes ─────────────────────────────

function NodeHistory({ node, timeframe }: { node: string; timeframe: Timeframe }) {
  const history = useNodeHistory(node, timeframe);
  return (
    <QueryBoundary
      query={history}
      integration="proxmox"
      compact
      skeleton={<ChartSkeleton height={168} />}
      isEmpty={(data) => data.length < 2}
      empty={<p className="flex h-[168px] items-center justify-center text-xs text-muted-foreground">Pas encore d'historique sur cette période.</p>}
    >
      {(data) => (
        <div className={cn('transition-opacity', history.isPlaceholderData && 'opacity-60')}>
          <TimeSeriesChart
            data={data}
            xKey="time"
            series={HISTORY_SERIES}
            height={168}
            domain={[0, 100]}
            formatX={formatTick(timeframe)}
            formatXLong={formatPoint}
            formatValue={(value) => formatPercent(value, 1)}
            formatAxis={(value) => `${Math.round(value)} %`}
            ariaLabel={`Charge CPU et mémoire du node ${node}`}
          />
        </div>
      )}
    </QueryBoundary>
  );
}

function NodeCard({ node, timeframe }: { node: ProxmoxNode; timeframe: Timeframe }) {
  return (
    <Card className="flex h-full flex-col">
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="truncate text-sm font-semibold">{node.node}</h3>
            <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              {node.pveVersion ? <span>PVE {node.pveVersion}</span> : null}
              <span>
                {formatNumber(node.cpuCores)} cœur{node.cpuCores > 1 ? 's' : ''}
              </span>
            </p>
          </div>
          <StatusBadge status={nodeStatus(node.online)} />
        </div>

        {node.online ? (
          <>
            <div className="grid grid-cols-1 gap-3">
              <Meter icon={Cpu} label="CPU" percent={node.cpuPercent} value={formatPercent(node.cpuPercent, 1)} />
              <Meter icon={MemoryStick} label="RAM" percent={ratio(node.memoryUsedBytes, node.memoryTotalBytes)} value={`${formatBytes(node.memoryUsedBytes)} / ${formatBytes(node.memoryTotalBytes)}`} />
              <Meter icon={HardDrive} label="Disque" percent={ratio(node.diskUsedBytes, node.diskTotalBytes)} value={`${formatBytes(node.diskUsedBytes)} / ${formatBytes(node.diskTotalBytes)}`} />
            </div>
            <dl className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-center">
              <div className="flex flex-col gap-0.5">
                <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Charge</dt>
                <dd className="tabular text-[13px] font-medium" title="Charge moyenne sur 1, 5 et 15 minutes">
                  {node.loadAverage ? node.loadAverage.map((value) => value.toFixed(2)).join(' · ') : '—'}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5 border-x">
                <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Uptime</dt>
                <dd className="tabular text-[13px] font-medium">{formatDuration(node.uptimeSeconds)}</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Invités</dt>
                <dd className="tabular text-[13px] font-medium">
                  {formatNumber(node.guests.running)} / {formatNumber(node.guests.total)}
                </dd>
              </div>
            </dl>
          </>
        ) : (
          <EmptyState compact icon={ServerOff} tone="danger" title="Node hors ligne" description="Ce node ne répond plus au cluster. Ses invités sont peut-être inaccessibles." />
        )}
      </div>
      {node.online ? (
        <div className="mt-auto border-t px-2 pb-3 pt-3 sm:px-3">
          <div className="mb-1 flex items-center justify-between gap-2 px-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Activity className="size-3.5" aria-hidden />
              Historique
            </p>
            <ChartLegend series={HISTORY_SERIES} />
          </div>
          <NodeHistory node={node.node} timeframe={timeframe} />
        </div>
      ) : null}
    </Card>
  );
}

function NodesSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3" aria-busy aria-label="Chargement des nodes">
      {[0, 1].map((index) => (
        <Card key={index} className="flex flex-col gap-4 p-4 sm:p-5">
          <div className="flex justify-between">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-36" />
            </div>
            <Skeleton className="h-[22px] w-20 rounded-full" />
          </div>
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex flex-col gap-1.5">
              <div className="flex justify-between">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-1.5 w-full rounded-full" />
            </div>
          ))}
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-[168px] rounded-lg" />
        </Card>
      ))}
    </div>
  );
}

// ───────────────────────────── Invités ─────────────────────────────

interface GuestActionSpec {
  label: string;
  done: string;
  icon: typeof Play;
  confirm?: { title: string; body: string; confirmLabel: string };
}

const GUEST_ACTIONS: Record<GuestAction, GuestActionSpec> = {
  start: { label: 'Démarrer', done: 'Démarrage lancé', icon: Play },
  reboot: {
    label: 'Redémarrer',
    done: 'Redémarrage lancé',
    icon: RotateCw,
    confirm: { title: 'Redémarrer cet invité ?', body: 'Le système invité sera redémarré : les services hébergés seront indisponibles pendant quelques instants.', confirmLabel: 'Redémarrer' },
  },
  shutdown: {
    label: 'Arrêt propre',
    done: 'Arrêt propre lancé',
    icon: Power,
    confirm: { title: 'Arrêter proprement cet invité ?', body: 'Le système invité recevra un signal d’extinction (ACPI) et s’arrêtera normalement. Les services hébergés seront interrompus.', confirmLabel: 'Arrêter' },
  },
  stop: {
    label: 'Arrêt forcé',
    done: 'Arrêt forcé lancé',
    icon: Zap,
    confirm: {
      title: 'Forcer l’arrêt de cet invité ?',
      body: 'L’invité sera coupé immédiatement, comme si on débranchait la machine : risque de perte de données et de corruption du système de fichiers.',
      confirmLabel: 'Forcer l’arrêt',
    },
  },
};

const guestActions = (guest: ProxmoxGuest): GuestAction[] => {
  if (guest.template) return [];
  if (guest.status === 'running') return ['reboot', 'shutdown', 'stop'];
  if (guest.status === 'paused') return ['shutdown', 'stop'];
  if (guest.status === 'stopped') return ['start'];
  return ['start', 'stop'];
};

function GuestType({ guest }: { guest: ProxmoxGuest }) {
  const vm = guest.type === 'qemu';
  const Icon = vm ? Monitor : Box;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
      <Icon className="size-3.5" aria-hidden />
      {vm ? 'VM' : 'Conteneur'}
    </span>
  );
}

function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span className="text-subtle">—</span>;
  return (
    <span className="flex max-w-[200px] flex-wrap gap-1">
      {tags.slice(0, 4).map((tag) => (
        <Badge key={tag} tone="outline" className="max-w-[120px]">
          <span className="truncate">{tag}</span>
        </Badge>
      ))}
      {tags.length > 4 ? <Badge>+{tags.length - 4}</Badge> : null}
    </span>
  );
}

function Usage({ guest }: { guest: ProxmoxGuest }) {
  if (guest.status !== 'running') return <span className="text-xs text-subtle">—</span>;
  return (
    <div className="grid min-w-[200px] grid-cols-1 gap-2">
      <Meter label={`CPU · ${guest.cpuCores} cœur${guest.cpuCores > 1 ? 's' : ''}`} percent={guest.cpuPercent} value={formatPercent(guest.cpuPercent, 1)} />
      <Meter label="RAM" percent={ratio(guest.memoryUsedBytes, guest.memoryTotalBytes)} value={`${formatBytes(guest.memoryUsedBytes)} / ${formatBytes(guest.memoryTotalBytes)}`} />
    </div>
  );
}

function GuestMenu({ guest, busy, onAction }: { guest: ProxmoxGuest; busy: boolean; onAction: (guest: ProxmoxGuest, action: GuestAction) => void }) {
  const actions = guestActions(guest);
  if (actions.length === 0) return null;
  const [first, ...rest] = actions;
  const primary = first ? GUEST_ACTIONS[first] : null;
  return (
    <div className="flex items-center justify-end gap-1.5">
      {first && primary ? (
        <Hint label={primary.label}>
          <Button variant="outline" size="icon-sm" disabled={busy} onClick={() => onAction(guest, first)} aria-label={`${primary.label} ${guest.name}`}>
            <primary.icon aria-hidden />
          </Button>
        </Hint>
      ) : null}
      {rest.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Autres actions pour ${guest.name}`}>
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {rest.map((action) => {
              const spec = GUEST_ACTIONS[action];
              return (
                <DropdownMenuItem key={action} destructive={action === 'stop'} disabled={busy} onSelect={() => onAction(guest, action)}>
                  <spec.icon aria-hidden />
                  {spec.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

const guestKey = (guest: ProxmoxGuest): string => `${guest.node}/${guest.type}/${guest.vmid}`;

function Guests() {
  const guests = useProxmoxGuests();
  const action = useGuestAction();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [node, setNode] = useState('all');
  const [type, setType] = useState<'all' | 'qemu' | 'lxc'>('all');
  const statusParam = params.get('status');
  const status = statusParam === 'running' || statusParam === 'stopped' ? statusParam : 'all';
  const [pending, setPending] = useState<{ guest: ProxmoxGuest; action: GuestAction } | null>(null);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());

  const all = useMemo(() => guests.data ?? [], [guests.data]);
  const nodes = useMemo(() => [...new Set(all.map((guest) => guest.node))].sort((a, b) => a.localeCompare(b, 'fr')), [all]);
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all
      .filter((guest) => node === 'all' || guest.node === node)
      .filter((guest) => type === 'all' || guest.type === type)
      .filter((guest) => status === 'all' || (status === 'running' ? guest.status === 'running' : guest.status !== 'running' && !guest.template))
      .filter((guest) => !needle || `${guest.name} ${guest.vmid} ${guest.node} ${guest.tags.join(' ')}`.toLowerCase().includes(needle))
      .sort((a, b) => a.vmid - b.vmid);
  }, [all, node, type, status, search]);

  const run = (guest: ProxmoxGuest, name: GuestAction) => {
    const key = guestKey(guest);
    setBusy((current) => new Set(current).add(key));
    action.mutate(
      { guest, action: name },
      {
        onSuccess: () => toast.success(GUEST_ACTIONS[name].done, { description: `${guest.name} (${guest.vmid}) — l'état se met à jour dans quelques secondes.` }),
        onError: (error) => {
          if (!isStepUpCancelled(error)) toast.error(`${GUEST_ACTIONS[name].label} : échec`, { description: errorMessage(error) });
        },
        onSettled: () =>
          setBusy((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          }),
      },
    );
  };
  const request = (guest: ProxmoxGuest, name: GuestAction) => (GUEST_ACTIONS[name].confirm ? setPending({ guest, action: name }) : run(guest, name));

  const name = (guest: ProxmoxGuest) => (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-2">
        <span className="max-w-[240px] truncate font-medium" title={guest.name}>
          {guest.name || `Invité ${guest.vmid}`}
        </span>
        {guest.template ? <Badge>Modèle</Badge> : null}
      </span>
      <span className="tabular text-xs text-muted-foreground">
        ID {guest.vmid} · {guest.node}
      </span>
    </div>
  );

  const columns: Column<ProxmoxGuest>[] = [
    { key: 'name', header: 'Invité', skeleton: 'w-40', cell: name },
    { key: 'type', header: 'Type', cell: (guest) => <GuestType guest={guest} /> },
    { key: 'status', header: 'Statut', cell: (guest) => <StatusBadge status={guest.template ? { label: 'Modèle', tone: 'neutral' } : guestStatus(guest.status)} /> },
    { key: 'usage', header: 'Ressources', skeleton: 'w-44', cell: (guest) => <Usage guest={guest} /> },
    {
      key: 'disk',
      header: 'Disque',
      cell: (guest) => (
        <span className="tabular whitespace-nowrap text-muted-foreground">
          {guest.type === 'lxc' && guest.diskUsedBytes > 0 ? `${formatBytes(guest.diskUsedBytes)} / ` : ''}
          {formatBytes(guest.diskTotalBytes)}
        </span>
      ),
    },
    { key: 'uptime', header: 'Uptime', cell: (guest) => <span className="tabular whitespace-nowrap text-muted-foreground">{guest.status === 'running' ? formatDuration(guest.uptimeSeconds) : '—'}</span> },
    { key: 'tags', header: 'Tags', cell: (guest) => <Tags tags={guest.tags} /> },
    { key: 'actions', header: '', align: 'right', skeleton: 'w-8', cell: (guest) => <GuestMenu guest={guest} busy={busy.has(guestKey(guest))} onAction={request} /> },
  ];

  const confirm = pending ? GUEST_ACTIONS[pending.action].confirm : undefined;
  const filtered = search !== '' || node !== 'all' || type !== 'all' || status !== 'all';

  return (
    <>
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b p-3 sm:p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <SearchInput value={search} onChange={setSearch} placeholder="Nom, ID, tag…" label="Rechercher un invité" />
            <div className="flex flex-wrap items-center gap-2">
              <Select value={node} onValueChange={setNode}>
                <SelectTrigger className="w-auto min-w-[9.5rem]" aria-label="Filtrer par node">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tous les nodes</SelectItem>
                  {nodes.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={type} onValueChange={(value) => setType(value === 'qemu' || value === 'lxc' ? value : 'all')}>
                <SelectTrigger className="w-auto min-w-[9.5rem]" aria-label="Filtrer par type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">VM et conteneurs</SelectItem>
                  <SelectItem value="qemu">VM (QEMU)</SelectItem>
                  <SelectItem value="lxc">Conteneurs (LXC)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <FilterChips
            label="Filtrer par statut"
            value={status}
            onChange={(value) => setParams(value === 'all' ? {} : { status: value }, { replace: true })}
            options={[
              { value: 'all', label: 'Tous', count: all.length },
              { value: 'running', label: 'En marche', count: all.filter((guest) => guest.status === 'running').length },
              { value: 'stopped', label: 'Arrêtés', count: all.filter((guest) => guest.status !== 'running' && !guest.template).length },
            ]}
          />
        </div>

        {guests.data ? (
          all.length === 0 ? (
            <EmptyState icon={Boxes} title="Aucune VM ni conteneur" description="Les invités du cluster Proxmox apparaîtront ici." />
          ) : visible.length === 0 ? (
            <EmptyState icon={SearchX} title="Aucun invité ne correspond" description={filtered ? 'Modifiez la recherche ou les filtres.' : undefined} />
          ) : (
            <DataTable
              columns={columns}
              rows={visible}
              rowKey={guestKey}
              caption="Machines virtuelles et conteneurs Proxmox"
              rowClassName={(guest) => (busy.has(guestKey(guest)) ? 'opacity-60' : undefined)}
              mobileCard={(guest) => (
                <div className="flex flex-col gap-3 px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    {name(guest)}
                    <StatusBadge status={guest.template ? { label: 'Modèle', tone: 'neutral' } : guestStatus(guest.status)} />
                  </div>
                  {guest.status === 'running' ? <Usage guest={guest} /> : null}
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <GuestType guest={guest} />
                      <span className="tabular text-muted-foreground">{formatBytes(guest.diskTotalBytes)}</span>
                      {guest.status === 'running' ? <span className="tabular text-muted-foreground">{formatDuration(guest.uptimeSeconds)}</span> : null}
                    </span>
                    <GuestMenu guest={guest} busy={busy.has(guestKey(guest))} onAction={request} />
                  </div>
                  {guest.tags.length > 0 ? <Tags tags={guest.tags} /> : null}
                </div>
              )}
            />
          )
        ) : guests.isError ? (
          <ErrorState error={guests.error} onRetry={() => void guests.refetch()} />
        ) : (
          <DataTableSkeleton columns={columns} rows={6} />
        )}
      </Card>

      <ConfirmDialog
        open={pending !== null && confirm !== undefined}
        onOpenChange={(open) => (!open ? setPending(null) : undefined)}
        title={confirm?.title ?? ''}
        description={
          <div className="flex flex-col gap-2">
            <p className="font-medium text-foreground">
              {pending?.guest.name} <span className="tabular font-normal text-muted-foreground">· ID {pending?.guest.vmid} · {pending?.guest.node}</span>
            </p>
            <p>{confirm?.body}</p>
            <p className="text-xs">Votre code 2FA pourra vous être demandé pour valider.</p>
          </div>
        }
        confirmLabel={confirm?.confirmLabel ?? 'Confirmer'}
        destructive
        onConfirm={() => {
          if (pending) run(pending.guest, pending.action);
          setPending(null);
        }}
      />
    </>
  );
}

export default function ProxmoxPage() {
  const nodes = useProxmoxNodes();
  const guests = useProxmoxGuests();
  const [timeframe, setTimeframe] = useState<Timeframe>('hour');

  return (
    <Page wide>
      <PageHeader
        title="Proxmox"
        description="Nodes du cluster, machines virtuelles et conteneurs. État actualisé automatiquement."
        actions={
          <RefreshButton
            onClick={() => {
              void nodes.refetch();
              void guests.refetch();
            }}
            loading={nodes.isFetching || guests.isFetching}
          />
        }
      />

      <QueryBoundary query={nodes} integration="proxmox" skeleton={<NodesSkeleton />}>
        {(data) => (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-[15px] font-semibold">
                Nodes <span className="tabular ml-1 text-sm font-normal text-muted-foreground">{data.filter((node) => node.online).length} / {data.length} en ligne</span>
              </h2>
              <FilterChips label="Période de l'historique" options={TIMEFRAMES} value={timeframe} onChange={setTimeframe} />
            </div>
            {data.length === 0 ? (
              <Card>
                <EmptyState icon={ServerOff} title="Aucun node" description="Le cluster Proxmox n'a renvoyé aucun node." />
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                {data.map((node, index) => (
                  <FadeIn key={node.node} index={index}>
                    <NodeCard node={node} timeframe={timeframe} />
                  </FadeIn>
                ))}
              </div>
            )}
            <h2 className="pt-1 text-[15px] font-semibold">VM et conteneurs</h2>
            <Guests />
          </>
        )}
      </QueryBoundary>
    </Page>
  );
}
