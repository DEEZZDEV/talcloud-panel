import type { WhmcsOrder } from '@shared/api-types';
import { ShoppingCart } from 'lucide-react';
import type { Column } from '@/components/shared/data-table';
import { ListCard } from '@/components/shared/list-card';
import { FilterChips, Page, PageHeader, SearchInput } from '@/components/shared/page';
import { StatusBadge } from '@/components/shared/status-badge';
import { useWhmcsOrders } from '@/features/whmcs/api';
import { ClientLink, TruncatedNotice } from '@/features/whmcs/components';
import { useListParams } from '@/hooks/use-list-params';
import { formatDate, formatMoney, formatSmartDate } from '@/lib/format';
import { orderStatus, paymentStatus } from '@/lib/status';

const STATUSES = [
  { value: 'all', label: 'Toutes' },
  { value: 'Pending', label: 'En attente' },
  { value: 'Active', label: 'Actives' },
  { value: 'Cancelled', label: 'Annulées' },
  { value: 'Fraud', label: 'Fraude' },
];

const Products = ({ order }: { order: WhmcsOrder }) =>
  order.products.length === 0 ? (
    <span className="text-muted-foreground">—</span>
  ) : (
    <span className="line-clamp-2 text-muted-foreground" title={order.products.join(', ')}>
      {order.products.join(', ')}
    </span>
  );

const columns: Column<WhmcsOrder>[] = [
  { key: 'number', header: 'Commande', skeleton: 'w-20', cell: (order) => <span className="tabular whitespace-nowrap font-mono text-xs">{order.orderNumber || `#${order.id}`}</span> },
  { key: 'client', header: 'Client', skeleton: 'w-36', cell: (order) => <ClientLink id={order.clientId} name={order.clientName} /> },
  { key: 'products', header: 'Produits', skeleton: 'w-52', className: 'max-w-[320px]', cell: (order) => <Products order={order} /> },
  { key: 'date', header: 'Date', cell: (order) => <span className="tabular whitespace-nowrap text-muted-foreground">{formatDate(order.date)}</span> },
  { key: 'method', header: 'Paiement', cell: (order) => <span className="whitespace-nowrap text-muted-foreground">{order.paymentMethod ?? '—'}</span> },
  {
    key: 'status',
    header: 'Statut',
    skeleton: 'w-28',
    cell: (order) => (
      <span className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={orderStatus(order.status)} />
        {order.paymentStatus ? <StatusBadge status={paymentStatus(order.paymentStatus)} /> : null}
      </span>
    ),
  },
  { key: 'amount', header: 'Montant', align: 'right', skeleton: 'w-16', cell: (order) => <span className="tabular whitespace-nowrap font-semibold">{formatMoney(order.amount, order.currency)}</span> },
];

export default function WhmcsOrdersPage() {
  const list = useListParams();
  const query = useWhmcsOrders({ search: list.search, status: list.status, page: list.page, pageSize: 25 });

  return (
    <Page>
      <PageHeader title="Commandes" description="Commandes passées dans WHMCS, des plus récentes aux plus anciennes." />
      <ListCard
        query={query}
        columns={columns}
        rowKey={(order) => order.id}
        caption="Liste des commandes WHMCS"
        integration="whmcs"
        filtered={list.search !== '' || list.status !== 'all'}
        emptyIcon={ShoppingCart}
        emptyTitle="Aucune commande"
        emptyDescription="Les commandes passées par vos clients apparaîtront ici."
        noun="commande"
        onPageChange={list.setPage}
        notice={(page) => (page.meta.truncated ? <TruncatedNotice className="m-3 sm:m-4" /> : null)}
        toolbar={
          <>
            <SearchInput value={list.searchInput} onChange={list.setSearchInput} placeholder="Client, n° de commande…" label="Rechercher une commande" />
            <FilterChips label="Filtrer par statut" options={STATUSES} value={list.status} onChange={list.setStatus} />
          </>
        }
        mobileCard={(order) => (
          <div className="flex flex-col gap-2 px-4 py-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <ClientLink id={order.clientId} name={order.clientName} className="truncate text-sm" />
                <span className="tabular text-xs text-muted-foreground">
                  {order.orderNumber || `#${order.id}`} · {formatSmartDate(order.date)}
                  {order.paymentMethod ? ` · ${order.paymentMethod}` : ''}
                </span>
              </div>
              <span className="tabular shrink-0 text-sm font-semibold">{formatMoney(order.amount, order.currency)}</span>
            </div>
            {order.products.length > 0 ? <p className="line-clamp-2 text-[13px] text-muted-foreground">{order.products.join(', ')}</p> : null}
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge status={orderStatus(order.status)} />
              {order.paymentStatus ? <StatusBadge status={paymentStatus(order.paymentStatus)} /> : null}
            </div>
          </div>
        )}
      />
    </Page>
  );
}
