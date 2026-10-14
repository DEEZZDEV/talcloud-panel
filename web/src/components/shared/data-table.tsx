import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
  /** Largeur du squelette de chargement (classe Tailwind). */
  skeleton?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  /** Rendu en carte sur mobile (le tableau n'est affiché qu'à partir de 768 px). */
  mobileCard: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  /** Données en cours de rafraîchissement : le contenu précédent reste affiché, atténué. */
  dimmed?: boolean;
  caption: string;
}

/** Tableau sur ordinateur, liste de cartes sur téléphone : mêmes données, deux mises en page. */
export function DataTable<T>({ columns, rows, rowKey, mobileCard, onRowClick, rowClassName, dimmed, caption }: DataTableProps<T>) {
  return (
    <div className={cn('transition-opacity duration-200', dimmed && 'opacity-60')} aria-busy={dimmed || undefined}>
      <Table containerClassName="hidden md:block">
        <caption className="sr-only">{caption}</caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => (
              <TableHead key={column.key} className={cn(column.align === 'right' && 'text-right', column.className)}>
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={rowKey(row)}
              className={cn(onRowClick && 'cursor-pointer', rowClassName?.(row))}
              onClick={
                onRowClick
                  ? (event) => {
                      // Un clic sur un lien ou un bouton de la ligne garde son comportement propre.
                      if ((event.target as HTMLElement).closest('a,button,[role="menuitem"]')) return;
                      onRowClick(row);
                    }
                  : undefined
              }
            >
              {columns.map((column) => (
                <TableCell key={column.key} className={cn(column.align === 'right' && 'text-right', column.className)}>
                  {column.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul className="divide-y md:hidden" aria-label={caption}>
        {rows.map((row) => (
          <li key={rowKey(row)} className={rowClassName?.(row)}>
            {mobileCard(row)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DataTableSkeleton<T>({ columns, rows = 8 }: { columns: Column<T>[]; rows?: number }) {
  return (
    <div aria-hidden>
      <Table containerClassName="hidden md:block">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => (
              <TableHead key={column.key} className={cn(column.align === 'right' && 'text-right', column.className)}>
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }, (_, index) => (
            <TableRow key={index} className="hover:bg-transparent">
              {columns.map((column) => (
                <TableCell key={column.key} className={column.className}>
                  <Skeleton className={cn('h-4', column.skeleton ?? 'w-24', column.align === 'right' && 'ml-auto')} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul className="divide-y md:hidden">
        {Array.from({ length: Math.min(rows, 6) }, (_, index) => (
          <li key={index} className="flex items-center justify-between gap-3 px-4 py-3.5">
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
            <Skeleton className="h-5 w-16 rounded-full" />
          </li>
        ))}
      </ul>
    </div>
  );
}
