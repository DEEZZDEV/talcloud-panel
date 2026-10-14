import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Settings2, CheckCheck, LoaderCircle, LogOut, Moon, PenSquare, Plus, Sun, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NAV_ITEMS } from '@/components/layout/nav';
import { StatusDot } from '@/components/shared/status-badge';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, Kbd } from '@/components/ui/command';
import { useAuth } from '@/features/auth/auth-context';
import { useMarkAllRead } from '@/features/notifications/api';
import { useWhmcsClients } from '@/features/whmcs/api';
import { useDebounce } from '@/hooks/use-debounce';
import { useThemeSetter } from '@/features/preferences/api';
import { useTheme } from '@/hooks/use-theme';
import { isNotConfigured } from '@/lib/api';
import { clientStatus } from '@/lib/status';

/** Comparaison insensible à la casse et aux accents. */
const fold = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Recherche globale (Ctrl+K / ⌘K) : pages, actions rapides et clients WHMCS (recherche serveur avec anti-rebond). */
export function CommandPalette({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const { toggleTheme } = useThemeSetter();
  const { signOut } = useAuth();
  const markAll = useMarkAllRead();
  const [search, setSearch] = useState('');
  const term = search.trim();
  const debounced = useDebounce(term, 280);
  const clientSearch = debounced.length >= 2 ? debounced : '';
  const clients = useWhmcsClients({ search: clientSearch, page: 1, pageSize: 6 }, open && clientSearch.length >= 2);

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  const actions = useMemo(
    () => [
      { id: 'compose', label: 'Écrire un nouveau message', keywords: 'mail email envoyer', icon: PenSquare, run: () => navigate('/mail?compose=1') },
      { id: 'my-space', label: 'Personnaliser mon espace (thème, accueil, push)', keywords: 'préférences accueil blocs thème mon espace', icon: Settings2, run: () => navigate('/settings#mon-espace') },
      { id: 'cost', label: 'Ajouter un coût', keywords: 'dépense charge whmcs', icon: Plus, run: () => navigate('/whmcs/costs?new=1') },
      { id: 'read-all', label: 'Marquer toutes les notifications comme lues', keywords: 'notifications lu', icon: CheckCheck, run: () => markAll.mutate() },
      {
        id: 'theme',
        label: theme === 'dark' ? 'Passer au thème clair' : 'Passer au thème sombre',
        keywords: 'apparence mode sombre clair dark light',
        icon: theme === 'dark' ? Sun : Moon,
        run: toggleTheme,
      },
      { id: 'logout', label: 'Se déconnecter', keywords: 'quitter session', icon: LogOut, run: () => void signOut('logout') },
    ],
    [markAll, navigate, signOut, theme, toggleTheme],
  );

  const needle = fold(term);
  const pages = needle ? NAV_ITEMS.filter((item) => fold(`${item.label} ${item.keywords ?? ''}`).includes(needle)) : NAV_ITEMS;
  const visibleActions = needle ? actions.filter((action) => fold(`${action.label} ${action.keywords}`).includes(needle)) : actions;

  const clientItems = clientSearch && clients.data ? clients.data.items : [];
  const searchingClients = term.length >= 2 && (debounced !== term || clients.isFetching);
  const whmcsOff = isNotConfigured(clients.error);
  const nothing = pages.length === 0 && visibleActions.length === 0 && clientItems.length === 0 && !searchingClients;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[max(1rem,12dvh)] z-50 w-[calc(100vw-1.5rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border bg-popover shadow-pop duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          <DialogPrimitive.Title className="sr-only">Recherche globale</DialogPrimitive.Title>
          <Command shouldFilter={false} loop label="Recherche globale">
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder="Rechercher une page, une action, un client…"
              trailing={searchingClients ? <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Recherche en cours" /> : <Kbd className="hidden sm:inline-flex">Échap</Kbd>}
            />
            <CommandList>
              {nothing ? <CommandEmpty>Aucun résultat pour « {term} ».</CommandEmpty> : null}

              {clientItems.length > 0 ? (
                <CommandGroup heading="Clients WHMCS">
                  {clientItems.map((client) => {
                    const status = clientStatus(client.status);
                    return (
                      <CommandItem key={`client-${client.id}`} value={`client-${client.id}`} onSelect={() => run(() => navigate(`/whmcs/clients/${client.id}`))}>
                        <UserRound aria-hidden />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-medium">{client.name}</span>
                          <span className="truncate text-xs text-muted-foreground">{[client.companyName, client.email].filter(Boolean).join(' · ')}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <StatusDot tone={status.tone} />
                          {status.label}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : null}

              {term.length >= 2 && !searchingClients && clientItems.length === 0 && !nothing ? (
                <p className="px-3.5 pb-1 pt-2 text-xs text-muted-foreground">
                  {whmcsOff ? 'Recherche de clients indisponible : WHMCS n’est pas configuré.' : clients.isError ? 'La recherche de clients WHMCS a échoué.' : 'Aucun client WHMCS ne correspond.'}
                </p>
              ) : null}

              {pages.length > 0 ? (
                <CommandGroup heading="Pages">
                  {pages.map((item) => (
                    <CommandItem key={item.to} value={`page-${item.to}`} onSelect={() => run(() => navigate(item.to))}>
                      <item.icon aria-hidden />
                      {item.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              {visibleActions.length > 0 ? (
                <CommandGroup heading="Actions rapides">
                  {visibleActions.map((action) => (
                    <CommandItem key={action.id} value={`action-${action.id}`} onSelect={() => run(action.run)}>
                      <action.icon aria-hidden />
                      {action.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
            <div className="hidden items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground sm:flex" aria-hidden>
              <span className="flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                naviguer
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd>
                ouvrir
              </span>
              <span className="ml-auto">Tapez au moins 2 lettres pour chercher un client</span>
            </div>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
