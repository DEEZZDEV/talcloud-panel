import { Suspense, useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { CommandPalette } from '@/components/layout/command-palette';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { IdleGuard } from '@/features/auth/idle-guard';
import { useServerEvents } from '@/features/notifications/use-server-events';
import { cn, readPreference, writePreference } from '@/lib/utils';

/** Squelette générique affiché pendant le chargement paresseux d'une page. */
export function PageFallback() {
  return (
    <div className="mx-auto flex w-full max-w-[1360px] flex-col gap-6 px-4 py-5 sm:px-6 sm:py-7 lg:px-8" aria-busy aria-label="Chargement de la page">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-[124px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}

/** Coquille de l'application connectée : sidebar, barre supérieure, recherche globale, temps réel, garde d'inactivité. */
export default function AppLayout() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => readPreference('tc-sidebar') === 'collapsed');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useServerEvents();

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      writePreference('tc-sidebar', current ? 'expanded' : 'collapsed');
      return !current;
    });
  }, []);

  // Ctrl+K / ⌘K : recherche globale.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Changement de page : fermeture du tiroir mobile et retour en haut.
  useEffect(() => {
    setDrawerOpen(false);
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className="flex min-h-dvh">
      <a
        href="#contenu"
        className="sr-only z-[60] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Aller au contenu
      </a>

      <aside
        className={cn('sticky top-0 hidden h-dvh shrink-0 border-r transition-[width] duration-200 ease-out lg:block', collapsed ? 'w-[60px]' : 'w-[244px]')}
        aria-label="Barre latérale"
      >
        <Sidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      </aside>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="p-0" hideClose>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Menu principal du panel</SheetDescription>
          <Sidebar collapsed={false} onNavigate={() => setDrawerOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenMenu={() => setDrawerOpen(true)} onOpenSearch={() => setPaletteOpen(true)} />
        <main id="contenu" tabIndex={-1} className="pb-safe flex-1 outline-none">
          <ErrorBoundary resetKey={location.pathname}>
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <IdleGuard />
    </div>
  );
}
