import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { NAV_SECTIONS, type NavItem } from '@/components/layout/nav';
import { Hint } from '@/components/ui/tooltip';
import { useMailUnreadSummary } from '@/features/mail/api';
import { useUnreadCount } from '@/features/notifications/api';
import { cn } from '@/lib/utils';

export function Logo({ compact, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
          <path d="M10.5 22.5h11.2a4.3 4.3 0 0 0 .9-8.5 6.2 6.2 0 0 0-11.9-1.4 5 5 0 0 0-.2 9.9z" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
        </svg>
      </span>
      {compact ? null : (
        <span className="flex flex-col leading-none">
          <span className="text-sm font-semibold tracking-tight">TalCloud</span>
          <span className="mt-1 text-2xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Panel</span>
        </span>
      )}
    </span>
  );
}

function CountBadge({ count, collapsed }: { count: number; collapsed: boolean }) {
  if (count <= 0) return null;
  const label = count > 99 ? '99+' : String(count);
  if (collapsed) {
    return <span aria-hidden className="absolute right-1.5 top-1.5 size-2 rounded-full bg-primary ring-2 ring-sidebar" />;
  }
  return (
    <span className="tabular ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-[11px] font-semibold text-link" aria-hidden>
      {label}
    </span>
  );
}

function NavEntry({ item, collapsed, count, onNavigate }: { item: NavItem; collapsed: boolean; count: number; onNavigate?: () => void }) {
  const link = (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      aria-label={count > 0 ? `${item.label} (${count} non lu${count > 1 ? 's' : ''})` : item.label}
      className={({ isActive }) =>
        cn(
          'group relative flex h-10 items-center gap-3 rounded-md text-[13px] font-medium transition-colors lg:h-9',
          collapsed ? 'w-10 justify-center lg:w-9' : 'px-2.5',
          isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && !collapsed ? <span aria-hidden className="absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" /> : null}
          <item.icon className={cn('size-4 shrink-0', isActive ? 'text-foreground' : 'text-subtle group-hover:text-foreground')} aria-hidden />
          {collapsed ? null : <span className="truncate">{item.label}</span>}
          <CountBadge count={count} collapsed={collapsed} />
        </>
      )}
    </NavLink>
  );
  return collapsed ? (
    <Hint label={item.label} side="right">
      {link}
    </Hint>
  ) : (
    link
  );
}

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  /** Appelé après un clic sur un lien (ferme le tiroir mobile). */
  onNavigate?: () => void;
  className?: string;
}

/** Navigation principale : sections, icônes, compteurs de non lus ; repliable sur ordinateur, en tiroir sur mobile. */
export function Sidebar({ collapsed, onToggleCollapsed, onNavigate, className }: SidebarProps) {
  const unread = useUnreadCount();
  const mail = useMailUnreadSummary();
  const counts = { notifications: unread.data?.count ?? 0, mail: mail.data?.total ?? 0 };

  return (
    <div className={cn('flex h-full flex-col bg-sidebar', className)}>
      <div className={cn('flex h-14 shrink-0 items-center', collapsed ? 'justify-center px-2' : 'px-4')}>
        <NavLink to="/" onClick={onNavigate} aria-label="TalCloud Panel — accueil" className="rounded-lg">
          <Logo compact={collapsed} />
        </NavLink>
      </div>

      <nav aria-label="Navigation principale" className={cn('flex flex-1 flex-col gap-5 overflow-y-auto py-3', collapsed ? 'items-center px-2' : 'px-3')}>
        {NAV_SECTIONS.map((section, index) => (
          <div key={section.label} className={cn('flex flex-col gap-0.5', collapsed && 'items-center')}>
            {collapsed ? (
              index > 0 ? <span aria-hidden className="mb-2 h-px w-6 bg-border" /> : null
            ) : (
              <p className="px-2.5 pb-1.5 text-2xs font-medium uppercase tracking-[0.1em] text-subtle">{section.label}</p>
            )}
            {section.items.map((item) => (
              <NavEntry key={item.to} item={item} collapsed={collapsed} count={item.badge ? counts[item.badge] : 0} onNavigate={onNavigate} />
            ))}
          </div>
        ))}
      </nav>

      {onToggleCollapsed ? (
        <div className={cn('shrink-0 border-t p-2', collapsed && 'flex justify-center')}>
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Déplier la navigation' : 'Replier la navigation'}
            aria-expanded={!collapsed}
            className={cn(
              'flex h-9 items-center gap-3 rounded-md text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground',
              collapsed ? 'w-9 justify-center' : 'w-full px-2.5',
            )}
          >
            {collapsed ? <PanelLeftOpen className="size-4" aria-hidden /> : <PanelLeftClose className="size-4" aria-hidden />}
            {collapsed ? null : 'Replier'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
