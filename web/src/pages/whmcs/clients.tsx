import type { WhmcsClient } from '@shared/api-types';
import { ChevronRight, Users } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { Column } from '@/components/shared/data-table';
import { ListCard } from '@/components/shared/list-card';
import { FilterChips, Page, PageHeader, SearchInput } from '@/components/shared/page';
import { StatusBadge } from '@/components/shared/status-badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useWhmcsClients } from '@/features/whmcs/api';
import { ClientLink, TruncatedNotice } from '@/features/whmcs/components';
import { useListParams } from '@/hooks/use-list-params';
import { formatDate } from '@/lib/format';
import { clientStatus } from '@/lib/status';
import { initials } from '@/lib/utils';

const STATUSES = [
  { value: 'all', label: 'Tous' },
  { value: 'Active', label: 'Actifs' },
  { value: 'Inactive', label: 'Inactifs' },
  { value: 'Closed', label: 'Fermés' },
];

const columns: Column<WhmcsClient>[] = [
  {
    key: 'client',
    header: 'Client',
    skeleton: 'w-44',
    cell: (client) => (
      <div className="flex items-center gap-3">
        <Avatar>
          <AvatarFallback>{initials(client.name)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col">
          <ClientLink id={client.id} name={client.name} className="truncate" />
          {client.companyName ? <span className="truncate text-xs text-muted-foreground">{client.companyName}</span> : null}
        </div>
      </div>
    ),
  },
  { key: 'email', header: 'E-mail', skeleton: 'w-48', cell: (client) => <span className="text-muted-foreground">{client.email}</span> },
  { key: 'created', header: 'Inscrit le', cell: (client) => <span className="tabular whitespace-nowrap text-muted-foreground">{formatDate(client.createdAt)}</span> },
  { key: 'status', header: 'Statut', skeleton: 'w-16', cell: (client) => <StatusBadge status={clientStatus(client.status)} /> },
  { key: 'id', header: 'N°', align: 'right', skeleton: 'w-10', cell: (client) => <span className="tabular text-muted-foreground">#{client.id}</span> },
];

export default function WhmcsClientsPage() {
  const navigate = useNavigate();
  const list = useListParams();
  const query = useWhmcsClients({ search: list.search, status: list.status, page: list.page, pageSize: 25 });

  return (
    <Page>
      <PageHeader title="Clients" description="Comptes clients WHMCS. Cliquez sur un client pour ouvrir sa fiche." />
      <ListCard
        query={query}
        columns={columns}
        rowKey={(client) => client.id}
        caption="Liste des clients WHMCS"
        integration="whmcs"
        filtered={list.search !== '' || list.status !== 'all'}
        emptyIcon={Users}
        emptyTitle="Aucun client"
        emptyDescription="Les clients créés dans WHMCS apparaîtront ici."
        noun="client"
        onPageChange={list.setPage}
        onRowClick={(client) => navigate(`/whmcs/clients/${client.id}`)}
        notice={(page) => (page.meta.truncated ? <TruncatedNotice className="m-3 sm:m-4" /> : null)}
        toolbar={
          <>
            <SearchInput value={list.searchInput} onChange={list.setSearchInput} placeholder="Nom, e-mail, société…" label="Rechercher un client" />
            <FilterChips label="Filtrer par statut" options={STATUSES} value={list.status} onChange={list.setStatus} />
          </>
        }
        mobileCard={(client) => (
          <Link to={`/whmcs/clients/${client.id}`} className="flex items-center gap-3 px-4 py-3.5 transition-colors active:bg-muted/60">
            <Avatar className="size-9">
              <AvatarFallback>{initials(client.name)}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium">{client.name}</span>
              <span className="truncate text-xs text-muted-foreground">{client.companyName ? `${client.companyName} · ` : ''}{client.email}</span>
            </span>
            <StatusBadge status={clientStatus(client.status)} />
            <ChevronRight className="size-4 shrink-0 text-subtle" aria-hidden />
          </Link>
        )}
      />
    </Page>
  );
}
