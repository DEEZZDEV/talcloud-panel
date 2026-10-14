import type { GameServer, GameServerState } from '@shared/api-types';
import { Ban, CircleCheck, Cpu, Gamepad2, HardDrive, LayoutGrid, List, MemoryStick, MoreHorizontal, Play, RotateCw, SearchX, Server, Skull, Square, UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Meter, ratio } from '@/components/shared/meter';
import { FadeIn, FilterChips, Page, PageHeader, RefreshButton, SearchInput } from '@/components/shared/page';
import { EmptyState, QueryBoundary } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Hint } from '@/components/ui/tooltip';
import { SERVERS_REFRESH_MS, useGameServers, useServerAction, type ServerAction } from '@/features/pterodactyl/api';
import { ClientLink } from '@/features/whmcs/components';
import { errorMessage, isStepUpCancelled } from '@/lib/api';
import { formatBytes, formatDuration, formatPercent } from '@/lib/format';
import { gameServerStatus } from '@/lib/status';
import { cn, safeExternalUrl } from '@/lib/utils';

type StatusFilter = 'all' | 'running' | 'offline' | 'suspended' | 'transition';

/** État affiché : la suspension l'emporte sur l'état d'alimentation. */
const effectiveState = (server: GameServer): GameServerState => (server.suspended ? 'suspended' : server.state);
const matches = (server: GameServer, filter: StatusFilter): boolean => {
  const state = effectiveState(server);
  if (filter === 'all') return true;
  if (filter === 'transition') return state === 'starting' || state === 'stopping' || state === 'installing' || state === 'unknown';
  return state === filter;
};

const fold = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

interface ActionSpec {
  label: string;
  done: string;
  icon: typeof Play;
  /** Confirmation explicite (action qui interrompt le service du client). */
  confirm?: { title: string; body: string; confirmLabel: string };
}

const ACTIONS: Record<ServerAction, ActionSpec> = {
  start: { label: 'Démarrer', done: 'Démarrage demandé', icon: Play },
  restart: {
    label: 'Redémarrer',
    done: 'Redémarrage demandé',
    icon: RotateCw,
    confirm: { title: 'Redémarrer ce serveur ?', body: 'Le serveur sera arrêté puis relancé. Les joueurs connectés seront déconnectés le temps du redémarrage.', confirmLabel: 'Redémarrer' },
  },
  stop: {
    label: 'Arrêter',
    done: 'Arrêt demandé',
    icon: Square,
    confirm: { title: 'Arrêter ce serveur ?', body: 'Le serveur sera arrêté proprement. Les joueurs connectés seront déconnectés.', confirmLabel: 'Arrêter le serveur' },
  },
  kill: {
    label: 'Forcer l’arrêt (kill)',
    done: 'Arrêt forcé envoyé',
    icon: Skull,
    confirm: {
      title: 'Forcer l’arrêt de ce serveur ?',
      body: 'Le processus sera tué immédiatement, sans sauvegarde : des données de jeu récentes peuvent être perdues. À n’utiliser que si le serveur ne répond plus.',
      confirmLabel: 'Forcer l’arrêt',
    },
  },
  suspend: {
    label: 'Suspendre',
    done: 'Serveur suspendu',
    icon: Ban,
    confirm: { title: 'Suspendre ce serveur ?', body: 'Le serveur sera arrêté et son propriétaire ne pourra plus y accéder ni le démarrer jusqu’à sa réactivation.', confirmLabel: 'Suspendre' },
  },
  unsuspend: { label: 'Réactiver', done: 'Serveur réactivé', icon: CircleCheck },
};

function availableActions(server: GameServer): { primary: ServerAction[]; more: ServerAction[] } {
  if (server.suspended) return { primary: ['unsuspend'], more: [] };
  const state = server.state;
  if (state === 'installing') return { primary: [], more: ['suspend'] };
  if (state === 'running') return { primary: ['restart', 'stop'], more: ['kill', 'suspend'] };
  if (state === 'starting' || state === 'stopping') return { primary: ['stop'], more: ['kill', 'restart', 'suspend'] };
  return { primary: ['start'], more: ['suspend'] };
}

function ResourceMeters({ server, compact }: { server: GameServer; compact?: boolean }) {
  const resources = server.resources;
  if (!resources) {
    return <p className={cn('text-xs text-muted-foreground', compact ? '' : 'rounded-lg border border-dashed px-3 py-4 text-center')}>{server.suspended ? 'Serveur suspendu : ressources non mesurées.' : 'Ressources indisponibles.'}</p>;
  }
  const { limits } = server;
  const cpuPercent = limits.cpuPercent > 0 ? (resources.cpuPercent / limits.cpuPercent) * 100 : Math.min(resources.cpuPercent, 100);
  return (
    <div className={cn('grid gap-3', compact ? 'min-w-[220px] grid-cols-1 gap-2' : 'grid-cols-1')}>
      <Meter icon={Cpu} label="CPU" percent={cpuPercent} value={limits.cpuPercent > 0 ? `${formatPercent(resources.cpuPercent)} / ${formatPercent(limits.cpuPercent)}` : formatPercent(resources.cpuPercent, 1)} />
      <Meter
        icon={MemoryStick}
        label="RAM"
        percent={ratio(resources.memoryBytes, limits.memoryBytes)}
        value={limits.memoryBytes > 0 ? `${formatBytes(resources.memoryBytes)} / ${formatBytes(limits.memoryBytes)}` : `${formatBytes(resources.memoryBytes)} · illimitée`}
      />
      <Meter
        icon={HardDrive}
        label="Disque"
        percent={ratio(resources.diskBytes, limits.diskBytes)}
        value={limits.diskBytes > 0 ? `${formatBytes(resources.diskBytes)} / ${formatBytes(limits.diskBytes)}` : `${formatBytes(resources.diskBytes)} · illimité`}
      />
    </div>
  );
}

function Owner({ server }: { server: GameServer }) {
  if (server.whmcsClient) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <UserRound className="size-3.5 shrink-0 text-subtle" aria-hidden />
        <ClientLink id={server.whmcsClient.id} name={server.whmcsClient.name} className="truncate" />
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
      <UserRound className="size-3.5 shrink-0 text-subtle" aria-hidden />
      <span className="truncate">{server.owner ? server.owner.username : 'Propriétaire inconnu'}</span>
    </span>
  );
}

function ServerActions({ server, busy, onAction, dense }: { server: GameServer; busy: boolean; onAction: (server: GameServer, action: ServerAction) => void; dense?: boolean }) {
  const { primary, more } = availableActions(server);
  const panelUrl = safeExternalUrl(server.panelUrl);
  return (
    <div className="flex items-center gap-1.5">
      {primary.map((action) => {
        const spec = ACTIONS[action];
        return dense ? (
          <Hint key={action} label={spec.label}>
            <Button variant="outline" size="icon-sm" disabled={busy} onClick={() => onAction(server, action)} aria-label={`${spec.label} ${server.name}`}>
              <spec.icon aria-hidden />
            </Button>
          </Hint>
        ) : (
          <Button key={action} variant={action === 'start' || action === 'unsuspend' ? 'default' : 'outline'} size="sm" disabled={busy} onClick={() => onAction(server, action)}>
            <spec.icon aria-hidden />
            {spec.label}
          </Button>
        );
      })}
      {more.length > 0 || panelUrl ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className={dense ? undefined : 'ml-auto'} aria-label={`Autres actions pour ${server.name}`}>
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {more.map((action) => {
              const spec = ACTIONS[action];
              return (
                <DropdownMenuItem key={action} destructive={action === 'kill' || action === 'suspend'} disabled={busy} onSelect={() => onAction(server, action)}>
                  <spec.icon aria-hidden />
                  {spec.label}
                </DropdownMenuItem>
              );
            })}
            {panelUrl ? (
              <>
                {more.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem asChild>
                  <a href={panelUrl} target="_blank" rel="noopener noreferrer">
                    <Server aria-hidden />
                    Ouvrir dans Pterodactyl
                  </a>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function ServerCard({ server, busy, onAction }: { server: GameServer; busy: boolean; onAction: (server: GameServer, action: ServerAction) => void }) {
  const status = gameServerStatus(effectiveState(server));
  return (
    <Card className={cn('flex h-full flex-col gap-4 p-4 transition-opacity sm:p-5', busy && 'opacity-70')}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="truncate text-sm font-semibold" title={server.name}>
            {server.name}
          </h3>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="font-mono">{server.identifier}</span>
            {server.node ? <span>· {server.node}</span> : null}
            {server.resources && server.resources.uptimeMs > 0 ? <span className="tabular">· en ligne depuis {formatDuration(server.resources.uptimeMs / 1000)}</span> : null}
          </p>
        </div>
        <StatusBadge status={status} />
      </div>
      <ResourceMeters server={server} />
      <div className="mt-auto flex flex-col gap-3">
        <div className="text-[13px]">
          <Owner server={server} />
        </div>
        <ServerActions server={server} busy={busy} onAction={onAction} />
      </div>
    </Card>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy aria-label="Chargement des serveurs">
      {Array.from({ length: 6 }, (_, index) => (
        <Card key={index} className="flex flex-col gap-4 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="h-[22px] w-20 rounded-full" />
          </div>
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex flex-col gap-1.5">
              <div className="flex justify-between">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-1.5 w-full rounded-full" />
            </div>
          ))}
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-28" />
        </Card>
      ))}
    </div>
  );
}

export default function GameServersPage() {
  const servers = useGameServers();
  const action = useServerAction();
  const [params, setParams] = useSearchParams();
  const statusParam = params.get('status');
  const status: StatusFilter = statusParam === 'running' || statusParam === 'offline' || statusParam === 'suspended' || statusParam === 'transition' ? statusParam : 'all';
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [pending, setPending] = useState<{ server: GameServer; action: ServerAction } | null>(null);
  const [busy, setBusy] = useState<Set<number>>(() => new Set());

  const all = useMemo(() => servers.data ?? [], [servers.data]);
  const counts = useMemo(() => ({ all: all.length, running: all.filter((s) => matches(s, 'running')).length, offline: all.filter((s) => matches(s, 'offline')).length, suspended: all.filter((s) => matches(s, 'suspended')).length, transition: all.filter((s) => matches(s, 'transition')).length }), [all]);
  const visible = useMemo(() => {
    const needle = fold(search.trim());
    return all
      .filter((server) => matches(server, status))
      .filter((server) => !needle || fold([server.name, server.identifier, server.node ?? '', server.owner?.username ?? '', server.owner?.email ?? '', server.whmcsClient?.name ?? ''].join(' ')).includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }, [all, status, search]);

  const run = (server: GameServer, name: ServerAction) => {
    setBusy((current) => new Set(current).add(server.id));
    action.mutate(
      { server, action: name },
      {
        onSuccess: () => toast.success(ACTIONS[name].done, { description: server.name }),
        onError: (error) => {
          if (!isStepUpCancelled(error)) toast.error(`${ACTIONS[name].label} : échec`, { description: errorMessage(error) });
        },
        onSettled: () =>
          setBusy((current) => {
            const next = new Set(current);
            next.delete(server.id);
            return next;
          }),
      },
    );
  };

  /** Les actions destructrices passent par une confirmation ; le code 2FA est ensuite demandé automatiquement si nécessaire. */
  const request = (server: GameServer, name: ServerAction) => (ACTIONS[name].confirm ? setPending({ server, action: name }) : run(server, name));

  const filters: { value: StatusFilter; label: string; count: number }[] = [
    { value: 'all', label: 'Tous', count: counts.all },
    { value: 'running', label: 'En ligne', count: counts.running },
    { value: 'offline', label: 'Hors ligne', count: counts.offline },
    { value: 'suspended', label: 'Suspendus', count: counts.suspended },
    ...(counts.transition > 0 || status === 'transition' ? [{ value: 'transition' as const, label: 'En transition', count: counts.transition }] : []),
  ];

  const columns: Column<GameServer>[] = [
    {
      key: 'name',
      header: 'Serveur',
      cell: (server) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="max-w-[260px] truncate font-medium" title={server.name}>
            {server.name}
          </span>
          <span className="text-xs text-muted-foreground">
            <span className="font-mono">{server.identifier}</span>
            {server.node ? ` · ${server.node}` : ''}
          </span>
        </div>
      ),
    },
    { key: 'status', header: 'Statut', cell: (server) => <StatusBadge status={gameServerStatus(effectiveState(server))} /> },
    { key: 'resources', header: 'Ressources', cell: (server) => <ResourceMeters server={server} compact /> },
    { key: 'owner', header: 'Propriétaire', className: 'max-w-[200px]', cell: (server) => <Owner server={server} /> },
    { key: 'actions', header: '', align: 'right', cell: (server) => <div className="flex justify-end"><ServerActions server={server} busy={busy.has(server.id)} onAction={request} dense /></div> },
  ];

  const confirm = pending ? ACTIONS[pending.action].confirm : undefined;

  return (
    <Page wide>
      <PageHeader
        title="Serveurs de jeu"
        description={`Serveurs Pterodactyl. État actualisé automatiquement toutes les ${Math.round(SERVERS_REFRESH_MS / 1000)} secondes.`}
        actions={<RefreshButton onClick={() => void servers.refetch()} loading={servers.isFetching} />}
      />

      <QueryBoundary query={servers} integration="pterodactyl" skeleton={<GridSkeleton />}>
        {() =>
          all.length === 0 ? (
            <Card>
              <EmptyState icon={Gamepad2} title="Aucun serveur de jeu" description="Les serveurs créés dans Pterodactyl apparaîtront ici avec leur état et leur consommation." />
            </Card>
          ) : (
            <>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <FilterChips
                  label="Filtrer par statut"
                  options={filters}
                  value={status}
                  onChange={(value) => setParams(value === 'all' ? {} : { status: value }, { replace: true })}
                />
                <div className="flex items-center gap-2">
                  <SearchInput value={search} onChange={setSearch} placeholder="Nom, node, propriétaire…" label="Rechercher un serveur" className="lg:w-72" />
                  <div className="hidden shrink-0 rounded-md border p-0.5 md:flex" role="group" aria-label="Mode d'affichage">
                    <Hint label="Grille">
                      <button type="button" onClick={() => setView('grid')} aria-pressed={view === 'grid'} aria-label="Affichage en grille" className={cn('flex size-8 items-center justify-center rounded text-muted-foreground', view === 'grid' && 'bg-accent text-foreground')}>
                        <LayoutGrid className="size-4" aria-hidden />
                      </button>
                    </Hint>
                    <Hint label="Liste">
                      <button type="button" onClick={() => setView('list')} aria-pressed={view === 'list'} aria-label="Affichage en liste" className={cn('flex size-8 items-center justify-center rounded text-muted-foreground', view === 'list' && 'bg-accent text-foreground')}>
                        <List className="size-4" aria-hidden />
                      </button>
                    </Hint>
                  </div>
                </div>
              </div>

              {visible.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={SearchX}
                    title="Aucun serveur ne correspond"
                    description="Modifiez la recherche ou le filtre de statut."
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSearch('');
                          setParams({}, { replace: true });
                        }}
                      >
                        Réinitialiser
                      </Button>
                    }
                  />
                </Card>
              ) : view === 'list' ? (
                <Card className="overflow-hidden">
                  <DataTable columns={columns} rows={visible} rowKey={(server) => server.id} caption="Serveurs de jeu" mobileCard={(server) => <div className="p-1"><ServerCard server={server} busy={busy.has(server.id)} onAction={request} /></div>} />
                </Card>
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {visible.map((server, index) => (
                    <FadeIn key={server.id} index={index}>
                      <ServerCard server={server} busy={busy.has(server.id)} onAction={request} />
                    </FadeIn>
                  ))}
                </div>
              )}
            </>
          )
        }
      </QueryBoundary>

      <ConfirmDialog
        open={pending !== null && confirm !== undefined}
        onOpenChange={(open) => (!open ? setPending(null) : undefined)}
        title={confirm?.title ?? ''}
        description={
          <div className="flex flex-col gap-2">
            <p className="font-medium text-foreground">{pending?.server.name}</p>
            <p>{confirm?.body}</p>
            <p className="text-xs">Votre code 2FA pourra vous être demandé pour valider.</p>
          </div>
        }
        confirmLabel={confirm?.confirmLabel ?? 'Confirmer'}
        destructive
        onConfirm={() => {
          if (pending) run(pending.server, pending.action);
          setPending(null);
        }}
      />
    </Page>
  );
}
