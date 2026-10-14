import type { HomeBlockId, UserPreferences } from '@shared/api-types';
import { ArrowDown, ArrowUp, Bell, Check, CircleCheck, Home, LoaderCircle, Mail, Monitor, Moon, Palette, RotateCcw, Sun, UserRound, type LucideIcon } from 'lucide-react';
import { useIsMutating } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ErrorState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/features/auth/auth-context';
import { useMailAccounts } from '@/features/mail/api';
import { groupAccounts } from '@/features/mail/visibility-badge';
import { ALL_HOME_BLOCKS, DEFAULT_PREFERENCES, HOME_BLOCKS, layoutRows, usePreferences, useThemeSetter, useUpdatePreferences } from '@/features/preferences/api';
import type { ThemePreference } from '@/hooks/use-theme';
import { qk } from '@/lib/query';
import { cn } from '@/lib/utils';

function Subsection({ icon: Icon, title, description, children, aside }: { icon: LucideIcon; title: string; description: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t px-4 py-5 first:border-t-0 sm:px-5" aria-labelledby={`pref-${title}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Icon className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
          <div className="flex min-w-0 flex-col gap-1">
            <h3 id={`pref-${title}`} className="text-sm font-semibold leading-tight">
              {title}
            </h3>
            <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p>
          </div>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

// ───────────────────────────── Thème ─────────────────────────────

const THEMES: { value: ThemePreference; label: string; icon: LucideIcon; hint: string }[] = [
  { value: 'dark', label: 'Sombre', icon: Moon, hint: 'Par défaut' },
  { value: 'light', label: 'Clair', icon: Sun, hint: 'Fond blanc' },
  { value: 'system', label: 'Système', icon: Monitor, hint: 'Suit votre appareil' },
];

/** Miniature de l'interface dans un thème donné (aperçu du choix). */
function ThemeSwatch({ value }: { value: ThemePreference }) {
  const pane = (dark: boolean) => (
    <div className={cn('flex h-full flex-1 gap-1 p-1.5', dark ? 'bg-[#0c0c0e]' : 'bg-[#f6f6f7]')}>
      <div className={cn('w-3 rounded-sm', dark ? 'bg-[#1a1a1e]' : 'bg-[#e6e6ea]')} />
      <div className="flex flex-1 flex-col gap-1">
        <div className={cn('h-1.5 w-2/3 rounded-full', dark ? 'bg-[#2c2c32]' : 'bg-[#d8d8de]')} />
        <div className={cn('flex-1 rounded-sm border', dark ? 'border-[#26262b] bg-[#131316]' : 'border-[#e3e3e8] bg-white')}>
          <div className="m-1 h-1 w-1/2 rounded-full bg-[#2563eb]" />
        </div>
      </div>
    </div>
  );
  return (
    <div className="flex h-14 w-full overflow-hidden rounded-md border" aria-hidden>
      {value === 'system' ? (
        <>
          {pane(false)}
          {pane(true)}
        </>
      ) : (
        pane(value === 'dark')
      )}
    </div>
  );
}

function ThemePicker({ value }: { value: ThemePreference }) {
  const { setTheme } = useThemeSetter();
  return (
    <div role="radiogroup" aria-label="Thème de l'interface" className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3">
      {THEMES.map((theme) => {
        const checked = theme.value === value;
        return (
          <label
            key={theme.value}
            className={cn(
              'flex cursor-pointer flex-col gap-2.5 rounded-lg border p-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40',
              checked ? 'border-primary/60 bg-primary/[0.06]' : 'hover:bg-accent/50',
            )}
          >
            <input type="radio" name="pref-theme" value={theme.value} checked={checked} onChange={() => setTheme(theme.value)} className="sr-only" />
            <ThemeSwatch value={theme.value} />
            <span className="flex items-center justify-between gap-2 px-0.5">
              <span className="flex items-center gap-1.5 text-[13px] font-medium">
                <theme.icon className="size-3.5 text-muted-foreground" aria-hidden />
                {theme.label}
              </span>
              {checked ? <Check className="size-4 text-link" aria-label="sélectionné" /> : <span className="text-xs text-subtle">{theme.hint}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

// ───────────────────────────── Push ─────────────────────────────

const PUSH_TYPES: { key: keyof UserPreferences['push']; label: string; text: string }[] = [
  { key: 'orders', label: 'Nouvelles commandes', text: 'Une notification à chaque commande passée dans WHMCS.' },
  { key: 'payments', label: 'Paiements reçus', text: 'Factures payées, avec le montant et le compte qui encaisse.' },
  { key: 'security', label: 'Alertes de sécurité', text: 'Connexions, échecs, changements de réglages.' },
  { key: 'system', label: 'Messages système', text: 'Informations du panel (intégrations, maintenance).' },
];

function PushPreferences({ value }: { value: UserPreferences['push'] }) {
  const update = useUpdatePreferences();
  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-y rounded-lg border">
        {PUSH_TYPES.map((item) => (
          <li key={item.key} className="flex items-center justify-between gap-4 px-3 py-3">
            <Label htmlFor={`push-${item.key}`} className="flex cursor-pointer flex-col gap-1 font-normal">
              <span className="font-medium">{item.label}</span>
              <span className="text-xs leading-snug text-muted-foreground">{item.text}</span>
            </Label>
            <Switch id={`push-${item.key}`} checked={value[item.key]} onCheckedChange={(checked) => update.mutate({ push: { [item.key]: checked } })} />
          </li>
        ))}
      </ul>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Ces choix ne concernent que les notifications push de <span className="font-medium text-foreground">vos</span> appareils (à activer dans Sécurité › Notifications push). Le centre de
        notifications et le temps réel du panel montrent toujours tout, et les{' '}
        <span className="font-medium text-foreground">alertes de sécurité par e-mail restent toujours envoyées</span>, quel que soit ce réglage.
      </p>
    </div>
  );
}

// ───────────────────────────── Blocs de l'accueil ─────────────────────────────

/** Aperçu miniature de l'accueil : mêmes rangées que la vraie page. */
function HomePreview({ blocks }: { blocks: HomeBlockId[] }) {
  const rows = layoutRows(blocks);
  return (
    <figure className="m-0 flex flex-col gap-2" aria-label="Aperçu de la page d'accueil">
      <figcaption className="text-xs font-medium text-muted-foreground">Aperçu</figcaption>
      <div className="flex min-h-40 flex-col gap-1.5 rounded-lg border bg-background/60 p-2.5">
        {rows.length === 0 ? (
          <p className="m-auto px-4 text-center text-xs text-muted-foreground">Aucun bloc : l'accueil affichera un message vous invitant à en choisir.</p>
        ) : (
          rows.map((row) => {
            const items = row.kind === 'single' ? [row.block] : row.blocks;
            const equal = row.kind === 'pair' && HOME_BLOCKS[row.blocks[0]].width === HOME_BLOCKS[row.blocks[1]].width;
            return (
              <div key={items.join('+')} className="flex gap-1.5">
                {items.map((block) => (
                  <div
                    key={block}
                    className={cn(
                      'flex min-h-8 items-center rounded-md border bg-card px-2 text-[11px] leading-tight text-muted-foreground',
                      row.kind === 'single' ? 'flex-1' : equal ? 'flex-1' : HOME_BLOCKS[block].width === 'wide' ? 'flex-[2]' : 'flex-1',
                      block === 'stats' && 'min-h-7',
                      (block === 'revenueChart' || block === 'notifications') && 'min-h-12',
                    )}
                  >
                    <span className="truncate">{HOME_BLOCKS[block].label}</span>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
      <p className="text-2xs text-subtle">Sur téléphone, les blocs s'empilent dans ce même ordre.</p>
    </figure>
  );
}

function HomeBlocksEditor({ saved }: { saved: HomeBlockId[] }) {
  const update = useUpdatePreferences();
  const [visible, setVisible] = useState<HomeBlockId[]>(saved);
  const [order, setOrder] = useState<HomeBlockId[]>(() => [...saved, ...ALL_HOME_BLOCKS.filter((block) => !saved.includes(block))]);
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const savedKey = saved.join(',');

  // Préférences relues (enregistrement, autre onglet) : le brouillon repart de l'état enregistré.
  useEffect(() => {
    const blocks = savedKey ? (savedKey.split(',') as HomeBlockId[]) : [];
    setVisible(blocks);
    setOrder([...blocks, ...ALL_HOME_BLOCKS.filter((block) => !blocks.includes(block))]);
  }, [savedKey]);

  const draft = useMemo(() => order.filter((block) => visible.includes(block)), [order, visible]);
  const dirty = draft.join(',') !== savedKey;

  const move = (block: HomeBlockId, delta: -1 | 1) => {
    const index = order.indexOf(block);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    next[index] = order[target] as HomeBlockId;
    next[target] = block;
    setOrder(next);
    // Le focus suit le bloc déplacé (navigation au clavier sans perdre sa place).
    const direction = delta < 0 ? 'up' : 'down';
    requestAnimationFrame(() => {
      const button = buttons.current.get(`${block}-${direction}`);
      if (button && !button.disabled) button.focus();
      else buttons.current.get(`${block}-${direction === 'up' ? 'down' : 'up'}`)?.focus();
    });
  };

  const toggle = (block: HomeBlockId, checked: boolean) => setVisible((current) => (checked ? [...current, block] : current.filter((item) => item !== block)));

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      <div className="flex flex-col gap-3">
        <ol className="flex flex-col gap-1.5" aria-label="Blocs de l'accueil, dans l'ordre d'affichage">
          {order.map((block, index) => {
            const shown = visible.includes(block);
            const meta = HOME_BLOCKS[block];
            return (
              <li key={block} className={cn('flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors', shown ? 'bg-card' : 'bg-muted/30')}>
                <Checkbox id={`block-${block}`} checked={shown} onCheckedChange={(checked) => toggle(block, checked === true)} aria-describedby={`block-${block}-text`} />
                <Label htmlFor={`block-${block}`} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 font-normal">
                  <span className={cn('truncate font-medium', !shown && 'text-muted-foreground')}>{meta.label}</span>
                  <span id={`block-${block}-text`} className="truncate text-xs text-muted-foreground">
                    {shown ? meta.description : 'Masqué'}
                  </span>
                </Label>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    ref={(element) => {
                      buttons.current.set(`${block}-up`, element);
                    }}
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => move(block, -1)}
                    disabled={index === 0}
                    aria-label={`Monter « ${meta.label} »`}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    ref={(element) => {
                      buttons.current.set(`${block}-down`, element);
                    }}
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => move(block, 1)}
                    disabled={index === order.length - 1}
                    aria-label={`Descendre « ${meta.label} »`}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => update.mutate({ home: { blocks: draft } })} disabled={!dirty} loading={update.isPending && dirty}>
            Enregistrer l'accueil
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              const blocks = savedKey ? (savedKey.split(',') as HomeBlockId[]) : [];
              setVisible(blocks);
              setOrder([...blocks, ...ALL_HOME_BLOCKS.filter((block) => !blocks.includes(block))]);
            }}
            disabled={!dirty}
          >
            Annuler
          </Button>
          <Button
            variant="subtle"
            onClick={() => {
              setVisible([...DEFAULT_PREFERENCES.home.blocks]);
              setOrder([...DEFAULT_PREFERENCES.home.blocks]);
            }}
          >
            <RotateCcw aria-hidden />
            Par défaut
          </Button>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {dirty ? 'Modifications non enregistrées' : `${draft.length} bloc${draft.length > 1 ? 's' : ''} affiché${draft.length > 1 ? 's' : ''}`}
          </span>
        </div>
      </div>
      <HomePreview blocks={draft} />
    </div>
  );
}

// ───────────────────────────── Boîte mail par défaut ─────────────────────────────

function DefaultMailbox({ value }: { value: number | null }) {
  const update = useUpdatePreferences();
  const accounts = useMailAccounts();
  const list = accounts.data ?? [];
  const groups = groupAccounts(list);
  const missing = value !== null && accounts.data !== undefined && !list.some((account) => account.id === value);

  if (accounts.isError) return <p className="text-[13px] text-danger">Liste des boîtes mail indisponible.</p>;
  if (!accounts.data) return <Skeleton className="h-10 max-w-sm" />;
  if (list.length === 0) return <p className="text-[13px] text-muted-foreground">Aucune boîte mail accessible pour l'instant. Ajoutez-en dans la section Comptes mail ci-dessous.</p>;

  return (
    <div className="flex flex-col gap-2">
      <Select value={value === null || missing ? 'none' : String(value)} onValueChange={(next) => update.mutate({ mail: { defaultAccountId: next === 'none' ? null : Number(next) } })}>
        <SelectTrigger className="max-w-sm" aria-label="Boîte mail ouverte par défaut">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Aucune (première boîte de la liste)</SelectItem>
          {groups.mine.length > 0 ? (
            <SelectGroup>
              <SelectLabel>Mes boîtes</SelectLabel>
              {groups.mine.map((account) => (
                <SelectItem key={account.id} value={String(account.id)}>
                  {account.label} — {account.address}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          {groups.shared.length > 0 ? (
            <SelectGroup>
              <SelectLabel>Boîtes partagées</SelectLabel>
              {groups.shared.map((account) => (
                <SelectItem key={account.id} value={String(account.id)}>
                  {account.label} — {account.address}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
        </SelectContent>
      </Select>
      {missing ? <p className="text-xs text-warning">La boîte choisie précédemment n'est plus accessible : la première boîte de la liste est ouverte à la place.</p> : null}
    </div>
  );
}

// ───────────────────────────── Section ─────────────────────────────

/** « Mon espace » : préférences propres au compte connecté (l'autre administrateur a les siennes). */
export function MySpaceSection() {
  const { user } = useAuth();
  const preferences = usePreferences();
  // Toutes les sous-sections enregistrent via la même clé de mutation : un seul indicateur pour la section.
  const saving = useIsMutating({ mutationKey: qk.preferences }) > 0;
  const [justSaved, setJustSaved] = useState(false);
  const wasSaving = useRef(false);

  useEffect(() => {
    if (wasSaving.current && !saving) {
      wasSaving.current = false;
      setJustSaved(true);
      const timer = window.setTimeout(() => setJustSaved(false), 2200);
      return () => window.clearTimeout(timer);
    }
    wasSaving.current = saving;
    return undefined;
  }, [saving]);

  const status = saving ? (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
      Enregistrement…
    </span>
  ) : justSaved ? (
    <span className="flex items-center gap-1.5 text-xs text-success">
      <CircleCheck className="size-3.5" aria-hidden />
      Enregistré
    </span>
  ) : null;

  return (
    <Card id="mon-espace" className="scroll-mt-20" role="region" aria-labelledby="mon-espace-title">
      <div className="flex items-start gap-3 border-b p-4 sm:p-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-link">
          <UserRound className="size-[18px]" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h2 id="mon-espace-title" className="text-[15px] font-semibold leading-tight">
              Mon espace
            </h2>
            <Badge tone="primary">{user?.username ?? 'Mon compte'}</Badge>
            <span aria-live="polite">{status}</span>
          </div>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Préférences propres à votre compte, enregistrées dès que vous les modifiez. L'autre administrateur a les siennes ; les données et les intégrations restent communes.
          </p>
        </div>
      </div>

      {preferences.data ? (
        <div className="flex flex-col">
          <Subsection icon={Palette} title="Thème" description="S'applique sur tous les appareils où vous êtes connecté. La bascule de la barre supérieure modifie aussi ce réglage.">
            <ThemePicker value={preferences.data.theme} />
          </Subsection>
          <Subsection icon={Bell} title="Notifications push que je reçois" description="Choisissez les types d'évènements qui déclenchent une notification push sur vos appareils.">
            <PushPreferences value={preferences.data.push} />
          </Subsection>
          <Subsection icon={Home} title="Page d'accueil" description="Cochez les blocs à afficher et réglez leur ordre avec les flèches (utilisables au clavier).">
            <HomeBlocksEditor saved={preferences.data.home.blocks} />
          </Subsection>
          <Subsection icon={Mail} title="Boîte mail par défaut" description="Boîte ouverte en arrivant sur la page Mails. Seules les boîtes auxquelles vous avez accès sont proposées.">
            <DefaultMailbox value={preferences.data.mail.defaultAccountId} />
          </Subsection>
        </div>
      ) : preferences.isError ? (
        <ErrorState compact error={preferences.error} onRetry={() => void preferences.refetch()} />
      ) : (
        <div className="flex flex-col gap-3 p-5" aria-busy aria-label="Chargement de vos préférences">
          <Skeleton className="h-20" />
          <Skeleton className="h-32" />
          <Skeleton className="h-40" />
        </div>
      )}
    </Card>
  );
}
