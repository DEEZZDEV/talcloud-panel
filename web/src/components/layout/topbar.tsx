import type { PanelNotification } from '@shared/api-types';
import { Bell, BellOff, CheckCheck, LogOut, Menu, Moon, Search, Settings, ShieldCheck, Sun } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { EmptyState, ErrorState } from '@/components/shared/states';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Hint } from '@/components/ui/tooltip';
import { useAuth } from '@/features/auth/auth-context';
import { useMarkAllRead, useMarkRead, useNotifications, useUnreadCount } from '@/features/notifications/api';
import { NotificationRow } from '@/features/notifications/notification-item';
import { useTheme } from '@/hooks/use-theme';
import { initials } from '@/lib/utils';

const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const unread = useUnreadCount();
  const list = useNotifications({ type: 'all', unreadOnly: false, page: 1, pageSize: 8 }, open);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const count = unread.data?.count ?? 0;

  const select = (notification: PanelNotification) => {
    if (!notification.read) markRead.mutate(notification.id);
    setOpen(false);
    navigate(`/notifications?open=${notification.id}`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint label="Notifications">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="relative" aria-label={count > 0 ? `Notifications : ${count} non lue${count > 1 ? 's' : ''}` : 'Notifications'}>
            <Bell aria-hidden />
            {count > 0 ? (
              <span
                aria-hidden
                className="tabular absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground ring-2 ring-background"
              >
                {count > 99 ? '99+' : count}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" className="flex max-h-[min(34rem,calc(100dvh-5rem))] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden p-0">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <p className="text-sm font-semibold">
            Notifications
            {count > 0 ? <span className="tabular ml-2 text-xs font-medium text-muted-foreground">{count} non lue{count > 1 ? 's' : ''}</span> : null}
          </p>
          <Button variant="subtle" size="sm" className="-mr-2 sm:h-7" disabled={count === 0 || markAll.isPending} onClick={() => markAll.mutate()}>
            <CheckCheck aria-hidden />
            Tout marquer lu
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {list.data ? (
            list.data.items.length > 0 ? (
              <ul className="divide-y">
                {list.data.items.map((notification) => (
                  <li key={notification.id}>
                    <NotificationRow notification={notification} onSelect={select} dense />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact icon={BellOff} title="Rien à signaler" description="Les commandes, paiements et alertes de sécurité apparaîtront ici." />
            )
          ) : list.isError ? (
            <ErrorState compact error={list.error} onRetry={() => void list.refetch()} />
          ) : (
            <ul className="divide-y" aria-hidden>
              {[0, 1, 2, 3].map((index) => (
                <li key={index} className="flex items-start gap-3 px-4 py-3">
                  <Skeleton className="size-9 rounded-full" />
                  <div className="flex flex-1 flex-col gap-2 pt-0.5">
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t p-1.5">
          <Button asChild variant="ghost" size="sm" className="w-full">
            <Link to="/notifications" onClick={() => setOpen(false)}>
              Voir toutes les notifications
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const label = theme === 'dark' ? 'Passer au thème clair' : 'Passer au thème sombre';
  return (
    <Hint label={label}>
      <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={label}>
        {theme === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
      </Button>
    </Hint>
  );
}

function UserMenu() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="ml-1 flex size-10 items-center justify-center rounded-full sm:size-9" aria-label={`Menu du compte ${user.username}`}>
          <Avatar>
            <AvatarFallback>{initials(user.username)}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex flex-col gap-0.5 py-2">
          <span className="truncate text-[13px] font-semibold text-foreground">{user.username}</span>
          <span className="truncate font-normal">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/security')}>
          <ShieldCheck aria-hidden />
          Sécurité du compte
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <Settings aria-hidden />
          Réglages
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={() => void signOut('logout')}>
          <LogOut aria-hidden />
          Se déconnecter
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Barre supérieure : menu mobile, recherche globale, cloche, thème, compte. */
export function Topbar({ onOpenMenu, onOpenSearch }: { onOpenMenu: () => void; onOpenSearch: () => void }) {
  return (
    <header className="pt-safe sticky top-0 z-30 border-b bg-background/80 backdrop-blur-md">
      <div className="flex h-14 items-center gap-2 px-3 sm:px-6 lg:px-8">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpenMenu} aria-label="Ouvrir la navigation">
          <Menu aria-hidden />
        </Button>

        <button
          type="button"
          onClick={onOpenSearch}
          className="group hidden h-9 w-full max-w-sm items-center gap-2.5 rounded-md border border-input bg-card/60 px-3 text-[13px] text-muted-foreground shadow-sm transition-colors hover:border-subtle/60 hover:text-foreground sm:flex"
          aria-label="Ouvrir la recherche globale"
          aria-keyshortcuts="Control+K Meta+K"
        >
          <Search className="size-4" aria-hidden />
          <span className="flex-1 text-left">Rechercher une page, un client…</span>
          <span className="flex items-center gap-1" aria-hidden>
            <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>

        <div className="ml-auto flex items-center gap-0.5">
          <Hint label="Rechercher">
            <Button variant="ghost" size="icon" className="sm:hidden" onClick={onOpenSearch} aria-label="Ouvrir la recherche globale">
              <Search aria-hidden />
            </Button>
          </Hint>
          <NotificationBell />
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
