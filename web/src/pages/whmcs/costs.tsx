import { zodResolver } from '@hookform/resolvers/zod';
import type { Cost, CostCategory, CostInput, CostRecurrence } from '@shared/api-types';
import { MoreHorizontal, Pencil, PiggyBank, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DataTable, DataTableSkeleton, type Column } from '@/components/shared/data-table';
import { Field } from '@/components/shared/misc';
import { FilterChips, Page, PageHeader } from '@/components/shared/page';
import { StatCard, StatCardSkeleton } from '@/components/shared/stat-card';
import { EmptyState, ErrorState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useCosts, useDeleteCost, useSaveCost, useWhmcsOverview } from '@/features/whmcs/api';
import { COST_CATEGORY_LABELS, COST_RECURRENCE_LABELS } from '@/features/whmcs/components';
import { errorMessage, isApiError, isStepUpCancelled } from '@/lib/api';
import { currentMonth, formatMoney, formatMonth } from '@/lib/format';
import { cn, isRecord } from '@/lib/utils';

const CATEGORIES = Object.keys(COST_CATEGORY_LABELS) as CostCategory[];
const RECURRENCES = Object.keys(COST_RECURRENCE_LABELS) as CostRecurrence[];
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;

/** « 12,50 » ou « 12.50 » → 12.5 ; NaN si la saisie n'est pas un montant à deux décimales au plus. */
function parseAmount(raw: string): number {
  const normalized = raw.replace(/\s/g, '').replace(',', '.');
  return /^\d{1,10}(\.\d{1,2})?$/.test(normalized) ? Number(normalized) : Number.NaN;
}

// Mêmes règles que le serveur (libellé ≤ 120, montant ≥ 0 à 2 décimales, mois YYYY-MM, fin ≥ début, notes ≤ 2000).
const formSchema = z
  .object({
    label: z.string().trim().min(1, 'Donnez un libellé à ce coût').max(120, '120 caractères au maximum'),
    category: z.enum(['servers', 'licenses', 'network', 'software', 'staff', 'fees', 'other']),
    amount: z
      .string()
      .min(1, 'Indiquez un montant')
      .refine((value) => Number.isFinite(parseAmount(value)), 'Montant invalide (ex. 49,90 — deux décimales au maximum)'),
    recurrence: z.enum(['monthly', 'yearly', 'one_time']),
    startMonth: z.string().regex(MONTH, 'Mois attendu au format AAAA-MM'),
    endMonth: z.string().refine((value) => value === '' || MONTH.test(value), 'Mois attendu au format AAAA-MM'),
    notes: z.string().max(2000, '2000 caractères au maximum'),
  })
  .refine((values) => values.recurrence === 'one_time' || values.endMonth === '' || values.endMonth >= values.startMonth, {
    path: ['endMonth'],
    message: 'Le mois de fin doit être postérieur ou égal au mois de début',
  });

type FormValues = z.infer<typeof formSchema>;

const emptyForm = (): FormValues => ({ label: '', category: 'servers', amount: '', recurrence: 'monthly', startMonth: currentMonth(), endMonth: '', notes: '' });
const toForm = (cost: Cost): FormValues => ({
  label: cost.label,
  category: cost.category,
  amount: String(cost.amount).replace('.', ','),
  recurrence: cost.recurrence,
  startMonth: cost.startMonth,
  endMonth: cost.endMonth ?? '',
  notes: cost.notes ?? '',
});

/** Part d'un coût imputée à un mois donné — même règle que le serveur (annuel lissé sur 12 mois). */
function monthlyShare(cost: Cost, month: string): number {
  if (cost.recurrence === 'one_time') return month === cost.startMonth ? cost.amount : 0;
  if (month < cost.startMonth || (cost.endMonth !== null && month > cost.endMonth)) return 0;
  return cost.recurrence === 'yearly' ? cost.amount / 12 : cost.amount;
}

function period(cost: Cost): string {
  const text =
    cost.recurrence === 'one_time'
      ? formatMonth(cost.startMonth)
      : cost.endMonth
        ? `${formatMonth(cost.startMonth, 'short')} → ${formatMonth(cost.endMonth, 'short')}`
        : `Depuis ${formatMonth(cost.startMonth, 'short')}`;
  // Majuscule initiale uniquement (pas « Depuis Nov. 25 »).
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function CostForm({ open, cost, currency, onClose }: { open: boolean; cost: Cost | null; currency: string; onClose: () => void }) {
  const save = useSaveCost();
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: emptyForm() });
  const { register, handleSubmit, control, reset, watch, setError, formState } = form;
  const errors = formState.errors;
  const recurrence = watch('recurrence');

  useEffect(() => {
    if (open) reset(cost ? toForm(cost) : emptyForm());
  }, [open, cost, reset]);

  const submit = handleSubmit(async (values) => {
    const input: CostInput = {
      label: values.label.trim(),
      category: values.category,
      amount: parseAmount(values.amount),
      recurrence: values.recurrence,
      startMonth: values.startMonth,
      endMonth: values.recurrence === 'one_time' || values.endMonth === '' ? null : values.endMonth,
      notes: values.notes.trim() || null,
    };
    try {
      await save.mutateAsync({ id: cost?.id ?? null, input });
      toast.success(cost ? 'Coût mis à jour' : 'Coût ajouté', { description: 'Le bénéfice net a été recalculé.' });
      onClose();
    } catch (error) {
      if (isStepUpCancelled(error)) return;
      // Erreurs de validation du serveur : rattachées aux champs concernés.
      if (isApiError(error) && error.code === 'VALIDATION_ERROR' && isRecord(error.details)) {
        let attached = false;
        for (const [field, messages] of Object.entries(error.details)) {
          if (field in values && Array.isArray(messages) && typeof messages[0] === 'string') {
            setError(field as keyof FormValues, { message: messages[0] });
            attached = true;
          }
        }
        if (attached) return;
      }
      toast.error('Enregistrement impossible', { description: errorMessage(error) });
    }
  });

  return (
    <Sheet open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <SheetContent className="max-w-md">
        <SheetHeader>
          <SheetTitle>{cost ? 'Modifier le coût' : 'Ajouter un coût'}</SheetTitle>
          <SheetDescription>Les coûts sont déduits du chiffre d'affaires pour calculer le bénéfice net.</SheetDescription>
        </SheetHeader>
        <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-1 flex-col" noValidate>
          <SheetBody className="flex flex-col gap-4">
            <Field id="cost-label" label="Libellé" error={errors.label?.message}>
              <Input id="cost-label" placeholder="Serveur dédié OVH" maxLength={120} aria-invalid={Boolean(errors.label)} autoComplete="off" {...register('label')} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field id="cost-category" label="Catégorie" error={errors.category?.message}>
                <Controller
                  control={control}
                  name="category"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="cost-category">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CATEGORIES.map((category) => (
                          <SelectItem key={category} value={category}>
                            {COST_CATEGORY_LABELS[category]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
              <Field id="cost-recurrence" label="Récurrence" error={errors.recurrence?.message}>
                <Controller
                  control={control}
                  name="recurrence"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="cost-recurrence">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RECURRENCES.map((value) => (
                          <SelectItem key={value} value={value}>
                            {COST_RECURRENCE_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
            </div>

            <Field
              id="cost-amount"
              label={`Montant (${currency})`}
              error={errors.amount?.message}
              hint={recurrence === 'yearly' ? 'Montant annuel : il est lissé sur 12 mois dans le calcul du bénéfice.' : recurrence === 'one_time' ? 'Dépense unique, comptée sur son mois.' : 'Montant payé chaque mois.'}
            >
              <Input id="cost-amount" inputMode="decimal" placeholder="49,90" className="tabular" aria-invalid={Boolean(errors.amount)} autoComplete="off" {...register('amount')} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field id="cost-start" label={recurrence === 'one_time' ? 'Mois de la dépense' : 'Mois de début'} error={errors.startMonth?.message} className={recurrence === 'one_time' ? 'col-span-2' : undefined}>
                <Input id="cost-start" type="month" placeholder="AAAA-MM" min="2000-01" max="2099-12" aria-invalid={Boolean(errors.startMonth)} {...register('startMonth')} />
              </Field>
              {recurrence === 'one_time' ? null : (
                <Field id="cost-end" label="Mois de fin" optional error={errors.endMonth?.message} hint="Vide = sans fin.">
                  <Input id="cost-end" type="month" placeholder="AAAA-MM" min="2000-01" max="2099-12" aria-invalid={Boolean(errors.endMonth)} {...register('endMonth')} />
                </Field>
              )}
            </div>

            <Field id="cost-notes" label="Notes" optional error={errors.notes?.message}>
              <Textarea id="cost-notes" rows={4} maxLength={2000} placeholder="Référence du contrat, fournisseur…" aria-invalid={Boolean(errors.notes)} {...register('notes')} />
            </Field>
          </SheetBody>
          <SheetFooter>
            <Button variant="outline" onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" loading={save.isPending}>
              {cost ? 'Enregistrer' : 'Ajouter le coût'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export default function WhmcsCostsPage() {
  const costs = useCosts();
  const overview = useWhmcsOverview();
  const remove = useDeleteCost();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Cost | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<Cost | null>(null);
  const [category, setCategory] = useState<CostCategory | 'all'>('all');
  const currency = overview.data?.currency ?? 'EUR';
  const month = currentMonth();

  // « Ajouter un coût » depuis la recherche globale (?new=1).
  useEffect(() => {
    if (params.get('new') === '1') {
      setEditing(null);
      setFormOpen(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const all = useMemo(() => costs.data ?? [], [costs.data]);
  const visible = useMemo(() => (category === 'all' ? all : all.filter((cost) => cost.category === category)), [all, category]);
  const totals = useMemo(() => {
    const monthly = all.reduce((sum, cost) => sum + monthlyShare(cost, month), 0);
    const recurring = all.filter((cost) => cost.recurrence !== 'one_time' && monthlyShare(cost, month) > 0);
    const yearly = recurring.reduce((sum, cost) => sum + monthlyShare(cost, month) * 12, 0);
    const byCategory = new Map<CostCategory, number>();
    for (const cost of all) {
      const share = monthlyShare(cost, month);
      if (share > 0) byCategory.set(cost.category, (byCategory.get(cost.category) ?? 0) + share);
    }
    const top = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
    return { monthly, yearly, active: all.filter((cost) => monthlyShare(cost, month) > 0).length, top };
  }, [all, month]);

  const categoryOptions = useMemo(() => {
    const used = new Set(all.map((cost) => cost.category));
    return [{ value: 'all' as const, label: 'Toutes', count: all.length }, ...CATEGORIES.filter((value) => used.has(value)).map((value) => ({ value, label: COST_CATEGORY_LABELS[value], count: all.filter((cost) => cost.category === value).length }))];
  }, [all]);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (cost: Cost) => {
    setEditing(cost);
    setFormOpen(true);
  };

  const confirmDelete = () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    remove.mutate(target.id, {
      onSuccess: () => toast.success('Coût supprimé', { description: target.label }),
      onError: (error) => {
        if (!isStepUpCancelled(error)) toast.error('Suppression impossible', { description: errorMessage(error) });
      },
    });
  };

  const actions = (cost: Cost) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions pour ${cost.label}`}>
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => openEdit(cost)}>
          <Pencil aria-hidden />
          Modifier
        </DropdownMenuItem>
        <DropdownMenuItem destructive onSelect={() => setDeleting(cost)}>
          <Trash2 aria-hidden />
          Supprimer
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const inactive = (cost: Cost) => monthlyShare(cost, month) === 0;

  const columns: Column<Cost>[] = [
    {
      key: 'label',
      header: 'Libellé',
      skeleton: 'w-48',
      cell: (cost) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{cost.label}</span>
          {cost.notes ? <span className="line-clamp-1 max-w-md text-xs text-muted-foreground">{cost.notes}</span> : null}
        </div>
      ),
    },
    { key: 'category', header: 'Catégorie', cell: (cost) => <Badge>{COST_CATEGORY_LABELS[cost.category] ?? cost.category}</Badge> },
    { key: 'recurrence', header: 'Récurrence', cell: (cost) => <span className="text-muted-foreground">{COST_RECURRENCE_LABELS[cost.recurrence] ?? cost.recurrence}</span> },
    { key: 'period', header: 'Période', skeleton: 'w-32', cell: (cost) => <span className="whitespace-nowrap text-muted-foreground">{period(cost)}</span> },
    { key: 'amount', header: 'Montant', align: 'right', cell: (cost) => <span className="tabular whitespace-nowrap font-semibold">{formatMoney(cost.amount, currency)}</span> },
    {
      key: 'share',
      header: 'Ce mois-ci',
      align: 'right',
      cell: (cost) => <span className={cn('tabular whitespace-nowrap', inactive(cost) ? 'text-subtle' : 'text-muted-foreground')}>{inactive(cost) ? 'Inactif' : formatMoney(monthlyShare(cost, month), currency)}</span>,
    },
    { key: 'actions', header: '', align: 'right', skeleton: 'w-6', className: 'w-12', cell: actions },
  ];

  return (
    <Page>
      <PageHeader
        title="Coûts"
        description="Dépenses saisies à la main (serveurs, licences, réseau…) pour calculer le bénéfice net. Les frais de passerelle sont déjà comptés automatiquement."
        actions={
          <Button onClick={openCreate}>
            <Plus aria-hidden />
            Ajouter un coût
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {costs.data ? (
          <>
            <StatCard label={`Total de ${formatMonth(month)}`} icon={PiggyBank} value={formatMoney(totals.monthly, currency)} hint={`${totals.active} coût${totals.active > 1 ? 's' : ''} actif${totals.active > 1 ? 's' : ''} ce mois-ci`} />
            <StatCard label="Projection annuelle" value={formatMoney(totals.yearly, currency)} hint="Coûts récurrents × 12" />
            <StatCard
              label="Premier poste"
              value={totals.top ? COST_CATEGORY_LABELS[totals.top[0]] : '—'}
              hint={totals.top ? `${formatMoney(totals.top[1], currency)} ce mois-ci` : 'Aucun coût actif'}
            />
          </>
        ) : costs.isError ? null : (
          [0, 1, 2].map((index) => <StatCardSkeleton key={index} />)
        )}
      </div>

      <Card className="overflow-hidden">
        {all.length > 0 ? (
          <div className="border-b p-3 sm:p-4">
            <FilterChips label="Filtrer par catégorie" options={categoryOptions} value={category} onChange={setCategory} />
          </div>
        ) : null}
        {costs.data ? (
          all.length === 0 ? (
            <EmptyState
              icon={PiggyBank}
              title="Aucun coût saisi"
              description="Ajoutez vos dépenses récurrentes ou ponctuelles pour obtenir un bénéfice net fidèle à la réalité."
              action={
                <Button onClick={openCreate}>
                  <Plus aria-hidden />
                  Ajouter un coût
                </Button>
              }
            />
          ) : (
            <DataTable
              columns={columns}
              rows={visible}
              rowKey={(cost) => cost.id}
              caption="Liste des coûts"
              rowClassName={(cost) => (inactive(cost) ? 'opacity-70' : undefined)}
              mobileCard={(cost) => (
                <div className="flex items-start gap-2 py-3 pl-4 pr-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex items-start justify-between gap-3">
                      <span className="break-words text-sm font-medium">{cost.label}</span>
                      <span className="tabular shrink-0 text-sm font-semibold">{formatMoney(cost.amount, currency)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <Badge>{COST_CATEGORY_LABELS[cost.category] ?? cost.category}</Badge>
                      <span>{COST_RECURRENCE_LABELS[cost.recurrence]}</span>
                      <span>· {period(cost)}</span>
                    </div>
                    {cost.notes ? <p className="line-clamp-2 text-xs text-muted-foreground">{cost.notes}</p> : null}
                  </div>
                  {actions(cost)}
                </div>
              )}
            />
          )
        ) : costs.isError ? (
          <ErrorState error={costs.error} onRetry={() => void costs.refetch()} />
        ) : (
          <DataTableSkeleton columns={columns} rows={5} />
        )}
      </Card>

      <CostForm open={formOpen} cost={editing} currency={currency} onClose={() => setFormOpen(false)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (!open ? setDeleting(null) : undefined)}
        title="Supprimer ce coût ?"
        description={
          <>
            « {deleting?.label} » ne sera plus déduit du chiffre d'affaires, y compris sur les mois passés. Cette action est définitive.
          </>
        }
        confirmLabel="Supprimer"
        destructive
        onConfirm={confirmDelete}
      />
    </Page>
  );
}
