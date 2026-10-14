import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Hint } from '@/components/ui/tooltip';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Conteneur de page : largeur maximale, marges cohérentes et entrée animée. */
export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className={cn('mx-auto flex w-full flex-col gap-5 px-4 py-5 sm:gap-6 sm:px-6 sm:py-7 lg:px-8', wide ? 'max-w-[1600px]' : 'max-w-[1360px]', className)}
    >
      {children}
    </motion.div>
  );
}

export function PageHeader({ title, description, actions, className }: { title: string; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn('flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-xl font-semibold leading-tight sm:text-[22px]">{title}</h1>
        {description ? <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Apparition échelonnée des éléments d'une grille ou d'une liste. */
export function FadeIn({ children, index = 0, className }: { children: ReactNode; index?: number; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay: Math.min(index, 10) * 0.035, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Rechercher…',
  className,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  label?: string;
}) {
  return (
    <div className={cn('relative w-full sm:max-w-xs', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className="pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
        autoComplete="off"
        spellCheck={false}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-1 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          aria-label="Effacer la recherche"
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export function RefreshButton({ onClick, loading, label = 'Actualiser' }: { onClick: () => void; loading?: boolean; label?: string }) {
  return (
    <Hint label={label}>
      <Button variant="outline" size="icon" onClick={onClick} aria-label={label}>
        <RefreshCw className={cn(loading && 'animate-spin')} aria-hidden />
      </Button>
    </Hint>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  className,
  noun = 'résultat',
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  className?: string;
  noun?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className={cn('flex items-center justify-between gap-3 px-4 py-3 sm:px-5', className)} aria-label="Pagination">
      <p className="tabular text-xs text-muted-foreground">
        {total === 0 ? `Aucun ${noun}` : `${formatNumber(from)}–${formatNumber(to)} sur ${formatNumber(total)} ${noun}${total > 1 ? 's' : ''}`}
      </p>
      <div className="flex items-center gap-1.5">
        <span className="tabular hidden text-xs text-muted-foreground sm:inline">
          Page {formatNumber(page)} / {formatNumber(pages)}
        </span>
        <Button variant="outline" size="icon-sm" onClick={() => onPageChange(page - 1)} disabled={page <= 1} aria-label="Page précédente">
          <ChevronLeft aria-hidden />
        </Button>
        <Button variant="outline" size="icon-sm" onClick={() => onPageChange(page + 1)} disabled={page >= pages} aria-label="Page suivante">
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

/** Pastilles de filtre (statut, type…) — un seul choix actif. */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 py-0.5', className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[13px] font-medium transition-colors sm:h-8 sm:px-3',
              active ? 'border-foreground/15 bg-foreground text-background' : 'bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {option.label}
            {option.count !== undefined ? <span className={cn('tabular text-xs', active ? 'opacity-70' : 'text-subtle')}>{formatNumber(option.count)}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
