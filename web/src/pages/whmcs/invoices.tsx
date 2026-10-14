import type { WhmcsInvoice } from '@shared/api-types';
import { FileText, TriangleAlert } from 'lucide-react';
import type { Column } from '@/components/shared/data-table';
import { ListCard } from '@/components/shared/list-card';
import { FilterChips, Page, PageHeader, SearchInput } from '@/components/shared/page';
import { StatusBadge } from '@/components/shared/status-badge';
import { useWhmcsInvoices, useWhmcsOverview } from '@/features/whmcs/api';
import { ClientLink, TruncatedNotice } from '@/features/whmcs/components';
import { useListParams } from '@/hooks/use-list-params';
import { formatDate, formatMoney, plural } from '@/lib/format';
import { invoiceStatus, isUnpaidInvoice } from '@/lib/status';
import { cn } from '@/lib/utils';

const STATUSES = [
  { value: 'all', label: 'Toutes' },
  { value: 'Unpaid', label: 'Impayées' },
  { value: 'Overdue', label: 'En retard' },
  { value: 'Paid', label: 'Payées' },
  { value: 'Cancelled', label: 'Annulées' },
  { value: 'Refunded', label: 'Remboursées' },
  { value: 'Draft', label: 'Brouillons' },
];

/** Échéance dépassée pour une facture non réglée. */
function isLate(invoice: WhmcsInvoice): boolean {
  if (!isUnpaidInvoice(invoice.status) || !invoice.dueDate) return false;
  const due = Date.parse(invoice.dueDate);
  return Number.isFinite(due) && due < Date.now() - 24 * 3600_000;
}

function DueDate({ invoice }: { invoice: WhmcsInvoice }) {
  const late = isLate(invoice);
  return (
    <span className={cn('tabular inline-flex items-center gap-1.5 whitespace-nowrap', late ? 'font-medium text-danger' : 'text-muted-foreground')}>
      {late ? <TriangleAlert className="size-3.5" aria-hidden /> : null}
      {formatDate(invoice.dueDate)}
      {late ? <span className="sr-only"> (échéance dépassée)</span> : null}
    </span>
  );
}

const columns: Column<WhmcsInvoice>[] = [
  { key: 'id', header: 'Facture', skeleton: 'w-14', cell: (invoice) => <span className="tabular font-mono text-xs">#{invoice.id}</span> },
  { key: 'client', header: 'Client', skeleton: 'w-40', cell: (invoice) => <ClientLink id={invoice.clientId} name={invoice.clientName} /> },
  { key: 'date', header: 'Émise le', cell: (invoice) => <span className="tabular whitespace-nowrap text-muted-foreground">{formatDate(invoice.date)}</span> },
  { key: 'due', header: 'Échéance', cell: (invoice) => <DueDate invoice={invoice} /> },
  { key: 'paid', header: 'Payée le', cell: (invoice) => <span className="tabular whitespace-nowrap text-muted-foreground">{formatDate(invoice.datePaid)}</span> },
  { key: 'method', header: 'Moyen', cell: (invoice) => <span className="whitespace-nowrap text-muted-foreground">{invoice.paymentMethod ?? '—'}</span> },
  { key: 'status', header: 'Statut', skeleton: 'w-20', cell: (invoice) => <StatusBadge status={invoiceStatus(invoice.status)} /> },
  { key: 'total', header: 'Total', align: 'right', skeleton: 'w-16', cell: (invoice) => <span className="tabular whitespace-nowrap font-semibold">{formatMoney(invoice.total, invoice.currency)}</span> },
];

/** Liseré d'accent sur les factures à encaisser : repérables d'un coup d'œil sans colorer toute la ligne. */
const unpaidRow = (invoice: WhmcsInvoice): string | undefined =>
  isUnpaidInvoice(invoice.status) ? cn('shadow-[inset_3px_0_0_0_hsl(var(--warning))]', isLate(invoice) && 'bg-danger/[0.04] shadow-[inset_3px_0_0_0_hsl(var(--danger))]') : undefined;

export default function WhmcsInvoicesPage() {
  const list = useListParams();
  const query = useWhmcsInvoices({ search: list.search, status: list.status, page: list.page, pageSize: 25 });
  const overview = useWhmcsOverview();
  const unpaid = overview.data?.unpaidInvoices;

  return (
    <Page>
      <PageHeader
        title="Factures"
        description={
          unpaid && unpaid.count > 0 ? (
            <>
              <span className="font-medium text-warning">{plural(unpaid.count, 'facture')} à encaisser</span> pour un total de{' '}
              <span className="tabular font-medium text-foreground">{formatMoney(unpaid.total, overview.data?.currency)}</span>.
            </>
          ) : (
            'Factures WHMCS. Les impayés sont mis en évidence.'
          )
        }
      />
      <ListCard
        query={query}
        columns={columns}
        rowKey={(invoice) => invoice.id}
        caption="Liste des factures WHMCS"
        integration="whmcs"
        filtered={list.search !== '' || list.status !== 'all'}
        emptyIcon={FileText}
        emptyTitle="Aucune facture"
        emptyDescription="Les factures émises par WHMCS apparaîtront ici."
        noun="facture"
        onPageChange={list.setPage}
        rowClassName={unpaidRow}
        notice={(page) => (page.meta.truncated ? <TruncatedNotice className="m-3 sm:m-4" /> : null)}
        toolbar={
          <>
            <SearchInput value={list.searchInput} onChange={list.setSearchInput} placeholder="Client, n° de facture…" label="Rechercher une facture" />
            <FilterChips label="Filtrer par statut" options={STATUSES} value={list.status} onChange={list.setStatus} />
          </>
        }
        mobileCard={(invoice) => (
          <div className="flex items-start justify-between gap-3 px-4 py-3.5">
            <div className="flex min-w-0 flex-col gap-1">
              <ClientLink id={invoice.clientId} name={invoice.clientName} className="truncate text-sm" />
              <span className="tabular text-xs text-muted-foreground">
                #{invoice.id} · émise le {formatDate(invoice.date)}
              </span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {invoice.datePaid ? <>Payée le {formatDate(invoice.datePaid)}</> : <>Échéance <DueDate invoice={invoice} /></>}
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <span className="tabular text-sm font-semibold">{formatMoney(invoice.total, invoice.currency)}</span>
              <StatusBadge status={invoiceStatus(invoice.status)} />
            </div>
          </div>
        )}
      />
    </Page>
  );
}
