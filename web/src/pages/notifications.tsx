import type { NotificationType, PanelNotification } from '@shared/api-types';
import { useQueryClient } from '@tanstack/react-query';
import { BellOff, CheckCheck, Inbox } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { FilterChips, Page, PageHeader, Pagination } from '@/components/shared/page';
import { EmptyState, QueryBoundary } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useMarkAllRead, useMarkRead, useNotifications, useUnreadCount } from '@/features/notifications/api';
import { NotificationDetail, NotificationRow } from '@/features/notifications/notification-item';
import { errorMessage } from '@/lib/api';
import { plural } from '@/lib/format';
import type { Page as PageData } from '@/lib/query';
import { cn } from '@/lib/utils';

type TypeFilter = NotificationType | 'all';
const TYPES: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'Toutes' },
  { value: 'order', label: 'Commandes' },
  { value: 'payment', label: 'Paiements' },
  { value: 'security', label: 'Sécurité' },
  { value: 'system', label: 'Système' },
];
const isType = (value: string | null): value is TypeFilter => TYPES.some((type) => type.value === value);

function ListSkeleton() {
  return (
    <ul className="divide-y" aria-hidden>
      {Array.from({ length: 8 }, (_, index) => (
        <li key={index} className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex flex-1 flex-col gap-2 pt-0.5">
            <div className="flex justify-between gap-3">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-3.5 w-3/4" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function NotificationsPage() {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const typeParam = params.get('type');
  const type: TypeFilter = isType(typeParam) ? typeParam : 'all';
  const unreadOnly = params.get('unread') === '1';
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const openId = Number.parseInt(params.get('open') ?? '', 10);

  const list = useNotifications({ type, unreadOnly, page, pageSize: 25 });
  const unread = useUnreadCount();
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const [selected, setSelected] = useState<PanelNotification | null>(null);
  const unreadCount = unread.data?.count ?? 0;

  const update = (changes: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );

  // Ouverture directe (?open=<id>) depuis un toast, la cloche ou une notification push.
  const lists = client.getQueriesData<PageData<PanelNotification>>({ queryKey: ['notifications', 'list'] });
  const fromUrl = useMemo(() => {
    if (!Number.isInteger(openId)) return null;
    for (const [, data] of lists) {
      const found = data?.items.find((notification) => notification.id === openId);
      if (found) return found;
    }
    return null;
    // `list.dataUpdatedAt` : relit le cache quand une liste vient d'arriver.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, list.dataUpdatedAt]);

  useEffect(() => {
    if (fromUrl) setSelected(fromUrl);
  }, [fromUrl]);

  const select = (notification: PanelNotification) => {
    setSelected(notification);
    update({ open: String(notification.id) });
    if (!notification.read) markRead.mutate(notification.id);
  };

  const close = () => {
    setSelected(null);
    update({ open: null });
  };

  return (
    <Page>
      <PageHeader
        title="Notifications"
        description={unreadCount > 0 ? `${plural(unreadCount, 'notification')} non lue${unreadCount > 1 ? 's' : ''}. Les nouvelles arrivent en temps réel.` : 'Historique des commandes, paiements et alertes. Les nouvelles arrivent en temps réel.'}
        actions={
          <Button
            variant="outline"
            disabled={unreadCount === 0}
            loading={markAll.isPending}
            onClick={() =>
              markAll.mutate(undefined, {
                onSuccess: () => toast.success('Toutes les notifications sont marquées comme lues'),
                onError: (error) => toast.error('Action impossible', { description: errorMessage(error) }),
              })
            }
          >
            <CheckCheck aria-hidden />
            Tout marquer lu
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <FilterChips label="Filtrer par type" options={TYPES} value={type} onChange={(value) => update({ type: value === 'all' ? null : value, page: null })} />
          <div className="flex min-h-10 items-center gap-2.5 sm:min-h-0">
            <Switch id="unread-only" checked={unreadOnly} onCheckedChange={(checked) => update({ unread: checked ? '1' : null, page: null })} />
            <Label htmlFor="unread-only" className="cursor-pointer font-normal text-muted-foreground">
              Non lues uniquement
            </Label>
          </div>
        </div>

        <QueryBoundary query={list} integration="notifications" skeleton={<ListSkeleton />}>
          {(data) =>
            data.items.length === 0 ? (
              unreadOnly || type !== 'all' ? (
                <EmptyState
                  icon={Inbox}
                  title={unreadOnly ? 'Tout est lu' : 'Aucune notification de ce type'}
                  description="Aucune notification ne correspond à ces filtres."
                  action={
                    <Button variant="outline" size="sm" onClick={() => update({ type: null, unread: null, page: null })}>
                      Réinitialiser les filtres
                    </Button>
                  }
                />
              ) : (
                <EmptyState icon={BellOff} title="Aucune notification" description="Les commandes, paiements reçus et alertes de sécurité s'afficheront ici dès qu'ils se produisent." />
              )
            ) : (
              <>
                <ul className={cn('divide-y transition-opacity', list.isPlaceholderData && 'opacity-60')}>
                  {data.items.map((notification) => (
                    <li key={notification.id} className={cn(!notification.read && 'bg-primary/[0.035]')}>
                      <NotificationRow notification={notification} onSelect={select} />
                    </li>
                  ))}
                </ul>
                <Pagination className="border-t" page={data.meta.page} pageSize={data.meta.pageSize} total={data.meta.total} onPageChange={(next) => update({ page: next <= 1 ? null : String(next) })} noun="notification" />
              </>
            )
          }
        </QueryBoundary>
      </Card>

      <Sheet open={selected !== null} onOpenChange={(open) => (!open ? close() : undefined)}>
        <SheetContent className="max-w-md">
          <SheetHeader>
            <SheetTitle>Détail de la notification</SheetTitle>
            <SheetDescription className="sr-only">Informations complètes sur la notification sélectionnée</SheetDescription>
          </SheetHeader>
          <SheetBody>{selected ? <NotificationDetail notification={selected} onNavigate={close} /> : null}</SheetBody>
        </SheetContent>
      </Sheet>
    </Page>
  );
}
