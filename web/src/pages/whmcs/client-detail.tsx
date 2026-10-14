import type { WhmcsClientDetail } from '@shared/api-types';
import { ArrowLeft, Building2, CalendarDays, FileText, Mail, MapPin, Package, Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ExternalLink } from '@/components/shared/misc';
import { Page } from '@/components/shared/page';
import { StatCard } from '@/components/shared/stat-card';
import { EmptyState, QueryBoundary } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useWhmcsClient } from '@/features/whmcs/api';
import { formatCountry, formatDate, formatMoney, formatNumber } from '@/lib/format';
import { clientStatus, invoiceStatus, isUnpaidInvoice, serviceStatus } from '@/lib/status';
import { cn, initials } from '@/lib/utils';

const CYCLES: Record<string, string> = {
  monthly: 'par mois',
  quarterly: 'par trimestre',
  'semi-annually': 'par semestre',
  semiannually: 'par semestre',
  annually: 'par an',
  biennially: 'tous les 2 ans',
  triennially: 'tous les 3 ans',
  'one time': 'paiement unique',
  onetime: 'paiement unique',
  'free account': 'gratuit',
  free: 'gratuit',
};
const cycleLabel = (cycle: string): string => CYCLES[cycle.trim().toLowerCase()] ?? cycle;

function Contact({ icon: Icon, label, children }: { icon: typeof Mail; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
      <div className="flex min-w-0 flex-col gap-0.5">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="break-words text-[13px] font-medium">{children}</dd>
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy aria-label="Chargement de la fiche client">
      <div className="flex items-center gap-4">
        <Skeleton className="size-14 rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-40" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-[124px] rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl lg:col-span-2" />
      </div>
    </div>
  );
}

function ClientView({ client }: { client: WhmcsClientDetail }) {
  return (
    <>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <Avatar className="size-14">
            <AvatarFallback className="text-base">{initials(client.name)}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <h1 className="break-words text-xl font-semibold leading-tight sm:text-[22px]">{client.name}</h1>
              <StatusBadge status={clientStatus(client.status)} />
            </div>
            <p className="tabular text-[13px] text-muted-foreground">
              Client n° {client.id}
              {client.companyName ? ` · ${client.companyName}` : ''}
            </p>
          </div>
        </div>
        <ExternalLink href={client.adminUrl} asButton className="self-start sm:self-auto">
          Ouvrir dans WHMCS
        </ExternalLink>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Total payé" value={formatMoney(client.stats.totalPaid, client.currency)} hint="Depuis l'inscription" />
        <StatCard
          label="Impayés"
          tone={client.stats.unpaidTotal > 0 ? 'warning' : 'default'}
          value={formatMoney(client.stats.unpaidTotal, client.currency)}
          hint={client.stats.unpaidTotal > 0 ? 'À encaisser' : 'Rien à encaisser'}
        />
        <StatCard label="Services actifs" value={formatNumber(client.stats.activeServices)} hint={`${formatNumber(client.services.length)} au total · crédit ${formatMoney(client.credit, client.currency)}`} />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Coordonnées</CardTitle>
          </CardHeader>
          <dl className="divide-y border-t px-4 sm:px-5">
            <Contact icon={Mail} label="E-mail">
              {client.email || '—'}
            </Contact>
            <Contact icon={Phone} label="Téléphone">
              {client.phone ?? '—'}
            </Contact>
            {client.companyName ? (
              <Contact icon={Building2} label="Société">
                {client.companyName}
              </Contact>
            ) : null}
            <Contact icon={MapPin} label="Adresse">
              {client.address ? <span className="whitespace-pre-line">{client.address}</span> : null}
              {client.address && client.country ? <br /> : null}
              {client.country ? formatCountry(client.country) : client.address ? null : '—'}
            </Contact>
            <Contact icon={CalendarDays} label="Client depuis">
              {formatDate(client.createdAt)}
            </Contact>
          </dl>
        </Card>

        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Services</CardTitle>
            </CardHeader>
            <div className="border-t">
              {client.services.length === 0 ? (
                <EmptyState compact icon={Package} title="Aucun service" description="Ce client n'a encore commandé aucun produit." />
              ) : (
                <ul className="divide-y">
                  {client.services.map((service) => (
                    <li key={service.id} className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="break-words text-[13px] font-medium">{service.name}</span>
                        <span className="break-all text-xs text-muted-foreground">
                          {service.domain ? `${service.domain} · ` : ''}
                          {service.nextDueDate ? `prochaine échéance le ${formatDate(service.nextDueDate)}` : 'sans échéance'}
                        </span>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <span className="tabular text-[13px] font-semibold">
                          {formatMoney(service.amount, client.currency)} <span className="font-normal text-muted-foreground">{cycleLabel(service.billingCycle)}</span>
                        </span>
                        <StatusBadge status={serviceStatus(service.status)} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader className="flex-row items-center justify-between gap-3">
              <CardTitle>Factures récentes</CardTitle>
              <Button asChild variant="subtle" size="sm" className="-mr-2">
                <Link to={`/whmcs/invoices?q=${encodeURIComponent(client.name)}`}>Toutes ses factures</Link>
              </Button>
            </CardHeader>
            <div className="border-t">
              {client.recentInvoices.length === 0 ? (
                <EmptyState compact icon={FileText} title="Aucune facture" description="Aucune facture n'a encore été émise pour ce client." />
              ) : (
                <ul className="divide-y">
                  {client.recentInvoices.map((invoice) => (
                    <li
                      key={invoice.id}
                      className={cn('flex items-center justify-between gap-3 px-4 py-3 sm:px-5', isUnpaidInvoice(invoice.status) && 'shadow-[inset_3px_0_0_0_hsl(var(--warning))]')}
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="tabular text-[13px] font-medium">Facture #{invoice.id}</span>
                        <span className="tabular text-xs text-muted-foreground">
                          {formatDate(invoice.date)}
                          {invoice.datePaid ? ` · payée le ${formatDate(invoice.datePaid)}` : invoice.dueDate ? ` · échéance le ${formatDate(invoice.dueDate)}` : ''}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="tabular text-[13px] font-semibold">{formatMoney(invoice.total, invoice.currency || client.currency)}</span>
                        <StatusBadge status={invoiceStatus(invoice.status)} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

export default function WhmcsClientPage() {
  const params = useParams();
  const id = /^[1-9]\d{0,9}$/.test(params.id ?? '') ? Number(params.id) : null;
  const query = useWhmcsClient(id);

  return (
    <Page>
      <Button asChild variant="subtle" size="sm" className="-ml-2 self-start">
        <Link to="/whmcs/clients">
          <ArrowLeft aria-hidden />
          Clients
        </Link>
      </Button>
      {id === null ? (
        <Card>
          <EmptyState icon={FileText} title="Client introuvable" description="Cet identifiant de client n'est pas valide." />
        </Card>
      ) : (
        <QueryBoundary query={query} integration="whmcs" skeleton={<DetailSkeleton />}>
          {(client) => <ClientView client={client} />}
        </QueryBoundary>
      )}
    </Page>
  );
}
