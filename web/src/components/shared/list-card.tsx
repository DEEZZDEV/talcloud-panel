import type { IntegrationName } from '@shared/api-types';
import type { UseQueryResult } from '@tanstack/react-query';
import { SearchX, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { DataTable, DataTableSkeleton, type Column } from '@/components/shared/data-table';
import { Pagination } from '@/components/shared/page';
import { EmptyState, QueryBoundary } from '@/components/shared/states';
import { Card } from '@/components/ui/card';
import type { Page } from '@/lib/query';

interface ListCardProps<T> {
  query: UseQueryResult<Page<T>>;
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  mobileCard: (row: T) => ReactNode;
  caption: string;
  /** Barre d'outils : recherche et filtres. */
  toolbar?: ReactNode;
  /** Bandeau optionnel sous la barre d'outils (avertissement de résultats partiels…). */
  notice?: (page: Page<T>) => ReactNode;
  integration?: IntegrationName;
  filtered: boolean;
  emptyIcon: LucideIcon;
  emptyTitle: string;
  emptyDescription: string;
  noun: string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  onPageChange: (page: number) => void;
  skeletonRows?: number;
}

/** Carte de liste paginée : barre d'outils, tableau (ou cartes sur mobile), états et pagination. */
export function ListCard<T>({
  query,
  columns,
  rowKey,
  mobileCard,
  caption,
  toolbar,
  notice,
  integration,
  filtered,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  noun,
  onRowClick,
  rowClassName,
  onPageChange,
  skeletonRows = 8,
}: ListCardProps<T>) {
  return (
    <Card className="overflow-hidden">
      {toolbar ? <div className="flex flex-col gap-3 border-b p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">{toolbar}</div> : null}
      <QueryBoundary query={query} integration={integration} skeleton={<DataTableSkeleton columns={columns} rows={skeletonRows} />}>
        {(page) => (
          <>
            {notice ? notice(page) : null}
            {page.items.length === 0 ? (
              filtered ? (
                <EmptyState icon={SearchX} title="Aucun résultat" description="Aucun élément ne correspond à ces critères. Modifiez la recherche ou les filtres." />
              ) : (
                <EmptyState icon={emptyIcon} title={emptyTitle} description={emptyDescription} />
              )
            ) : (
              <DataTable
                columns={columns}
                rows={page.items}
                rowKey={rowKey}
                mobileCard={mobileCard}
                onRowClick={onRowClick}
                rowClassName={rowClassName}
                dimmed={query.isPlaceholderData}
                caption={caption}
              />
            )}
            {page.meta.total > 0 ? <Pagination className="border-t" page={page.meta.page} pageSize={page.meta.pageSize} total={page.meta.total} onPageChange={onPageChange} noun={noun} /> : null}
          </>
        )}
      </QueryBoundary>
    </Card>
  );
}
