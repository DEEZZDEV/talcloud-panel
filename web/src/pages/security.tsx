import type { AuditEntry, BackupCodes, KnownDevice, SessionInfo, TotpSetup } from '@shared/api-types';
import {
  Check,
  CircleCheck,
  CircleX,
  Eye,
  EyeOff,
  Fingerprint,
  Globe,
  History,
  KeyRound,
  Laptop,
  LifeBuoy,
  Lock,
  LogOut,
  MonitorSmartphone,
  Plus,
  QrCode,
  ScrollText,
  ShieldAlert,
  Smartphone,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import type { Column } from '@/components/shared/data-table';
import { ListCard } from '@/components/shared/list-card';
import { CopyButton, Field } from '@/components/shared/misc';
import { FilterChips, Page, PageHeader } from '@/components/shared/page';
import { EmptyState, QueryBoundary } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { CodeInput } from '@/components/ui/input-otp';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import {
  useAudit,
  useBackupCodesStatus,
  useChangePassword,
  useConfirmTotp,
  useDevices,
  useForgetDevice,
  useIpAllowlist,
  useRegenerateBackupCodes,
  useRegenerateTotp,
  useRevokeOtherSessions,
  useRevokeSession,
  useSessions,
  useUpdateAllowlist,
} from '@/features/security/api';
import { errorMessage, isApiError, isStepUpCancelled } from '@/lib/api';
import { formatCountry, formatDateTime, formatRelative } from '@/lib/format';
import { cn, isRecord } from '@/lib/utils';

const notifyError = (title: string) => (error: unknown) => {
  if (!isStepUpCancelled(error)) toast.error(title, { description: errorMessage(error) });
};

const deviceIcon = (label: string) => (/android|ios|iphone|ipad|mobile/i.test(label) ? Smartphone : Laptop);

function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="divide-y" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="flex items-center gap-3 px-4 py-4 sm:px-5">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-48 max-w-full" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
          <Skeleton className="h-8 w-24" />
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────────── Sessions ─────────────────────────────

function SessionsTab() {
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const { signOut } = useAuth();
  const [target, setTarget] = useState<SessionInfo | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);
  const others = (sessions.data ?? []).filter((session) => !session.current).length;

  const doRevoke = () => {
    if (!target) return;
    const session = target;
    setTarget(null);
    revoke.mutate(session.id, {
      onSuccess: () => {
        if (session.current) void signOut('logout', false);
        else toast.success('Session fermée', { description: session.deviceLabel });
      },
      onError: notifyError('Révocation impossible'),
    });
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>Sessions actives</CardTitle>
          <CardDescription>Appareils actuellement connectés à votre compte. Fermez celles que vous ne reconnaissez pas.</CardDescription>
        </div>
        <Button variant="destructive-outline" size="sm" disabled={others === 0} loading={revokeOthers.isPending} onClick={() => setConfirmOthers(true)}>
          <LogOut aria-hidden />
          Fermer les autres sessions
        </Button>
      </CardHeader>
      <div className="border-t">
        <QueryBoundary query={sessions} skeleton={<RowsSkeleton />}>
          {(data) => (
            <ul className="divide-y">
              {data.map((session) => {
                const Icon = deviceIcon(session.deviceLabel);
                return (
                  <li key={session.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-full border', session.current ? 'border-success/25 bg-success/10 text-success' : 'bg-muted text-muted-foreground')}>
                        <Icon className="size-[18px]" aria-hidden />
                      </span>
                      <div className="flex min-w-0 flex-col gap-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          <span className="break-words">{session.deviceLabel}</span>
                          {session.current ? <Badge tone="success">Cette session</Badge> : null}
                        </p>
                        <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                          <span className="font-mono">{session.ip}</span>
                          <span>· {formatCountry(session.country)}</span>
                          <span>· active {formatRelative(session.lastSeenAt)}</span>
                        </p>
                        <p className="text-xs text-subtle">
                          Ouverte le {formatDateTime(session.createdAt)} · expire le {formatDateTime(session.expiresAt)}
                        </p>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" className="self-start sm:self-auto" onClick={() => setTarget(session)} disabled={revoke.isPending}>
                      {session.current ? 'Se déconnecter' : 'Révoquer'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryBoundary>
      </div>

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => (!open ? setTarget(null) : undefined)}
        title={target?.current ? 'Fermer votre session actuelle ?' : 'Révoquer cette session ?'}
        description={target?.current ? 'Vous serez déconnecté immédiatement de cet appareil.' : `« ${target?.deviceLabel ?? ''} » (${target?.ip ?? ''}) sera déconnecté immédiatement.`}
        confirmLabel={target?.current ? 'Se déconnecter' : 'Révoquer'}
        destructive
        onConfirm={doRevoke}
      />
      <ConfirmDialog
        open={confirmOthers}
        onOpenChange={setConfirmOthers}
        title="Fermer toutes les autres sessions ?"
        description={`${others} autre${others > 1 ? 's' : ''} session${others > 1 ? 's' : ''} ser${others > 1 ? 'ont' : 'a'} fermée${others > 1 ? 's' : ''}. Votre session actuelle reste ouverte.`}
        confirmLabel="Fermer les autres sessions"
        destructive
        onConfirm={() => {
          setConfirmOthers(false);
          revokeOthers.mutate(undefined, {
            onSuccess: (result) => toast.success(`${result.revoked} session${result.revoked > 1 ? 's' : ''} fermée${result.revoked > 1 ? 's' : ''}`),
            onError: notifyError('Révocation impossible'),
          });
        }}
      />
    </Card>
  );
}

// ───────────────────────────── Journal ─────────────────────────────

const AUDIT_SCOPES = [
  { value: 'all', label: 'Toutes les actions' },
  { value: 'auth.', label: 'Connexion et 2FA' },
  { value: 'security.', label: 'Sécurité du compte' },
  { value: 'settings.', label: 'Réglages' },
  { value: 'whmcs.', label: 'WHMCS' },
  { value: 'mail.', label: 'Mails' },
  { value: 'pterodactyl.', label: 'Serveurs de jeu' },
  { value: 'proxmox.', label: 'Proxmox' },
  { value: 'notifications.', label: 'Notifications' },
];

const AUDIT_RESULTS: { value: 'all' | 'true' | 'false'; label: string }[] = [
  { value: 'all', label: 'Tout' },
  { value: 'true', label: 'Succès' },
  { value: 'false', label: 'Échecs' },
];

function Outcome({ success }: { success: boolean }) {
  return success ? (
    <Badge tone="success">
      <CircleCheck className="size-3" aria-hidden />
      Succès
    </Badge>
  ) : (
    <Badge tone="danger">
      <CircleX className="size-3" aria-hidden />
      Échec
    </Badge>
  );
}

/** Résumé court des détails d'une entrée (valeurs simples uniquement, rendues en texte). */
function detailsSummary(details: AuditEntry['details']): string {
  if (!details) return '';
  return Object.entries(details)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    .slice(0, 4)
    .map(([key, value]) => `${key} : ${String(value)}`)
    .join(' · ')
    .slice(0, 160);
}

const auditColumns: Column<AuditEntry>[] = [
  { key: 'at', header: 'Date', skeleton: 'w-28', cell: (entry) => <span className="tabular whitespace-nowrap text-muted-foreground">{formatDateTime(entry.at)}</span> },
  {
    key: 'action',
    header: 'Action',
    skeleton: 'w-48',
    cell: (entry) => (
      <div className="flex min-w-0 max-w-md flex-col gap-0.5">
        <span className="break-all font-mono text-xs font-medium">{entry.action}</span>
        {entry.target || entry.details ? <span className="line-clamp-2 break-words text-xs text-muted-foreground">{[entry.target, detailsSummary(entry.details)].filter(Boolean).join(' — ')}</span> : null}
      </div>
    ),
  },
  { key: 'result', header: 'Résultat', skeleton: 'w-16', cell: (entry) => <Outcome success={entry.success} /> },
  {
    key: 'origin',
    header: 'Origine',
    skeleton: 'w-36',
    cell: (entry) => (
      <div className="flex flex-col gap-0.5 text-xs">
        <span className="font-mono">{entry.ip ?? '—'}</span>
        <span className="text-muted-foreground">{[entry.country ? formatCountry(entry.country) : null, entry.deviceLabel].filter(Boolean).join(' · ') || '—'}</span>
      </div>
    ),
  },
];

function AuditTab() {
  const [scope, setScope] = useState('all');
  const [success, setSuccess] = useState<'all' | 'true' | 'false'>('all');
  const [page, setPage] = useState(1);
  const audit = useAudit({ action: scope === 'all' ? '' : scope, success, page, pageSize: 25 });

  return (
    <ListCard
      query={audit}
      columns={auditColumns}
      rowKey={(entry) => entry.id}
      caption="Journal d'activité"
      filtered={scope !== 'all' || success !== 'all'}
      emptyIcon={ScrollText}
      emptyTitle="Journal vide"
      emptyDescription="Les connexions et les actions sensibles seront consignées ici."
      noun="entrée"
      onPageChange={setPage}
      skeletonRows={10}
      toolbar={
        <>
          <Select
            value={scope}
            onValueChange={(value) => {
              setScope(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="sm:w-60" aria-label="Filtrer par type d'action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUDIT_SCOPES.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FilterChips
            label="Filtrer par résultat"
            options={AUDIT_RESULTS}
            value={success}
            onChange={(value) => {
              setSuccess(value);
              setPage(1);
            }}
          />
        </>
      }
      mobileCard={(entry) => (
        <div className="flex flex-col gap-1.5 px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <span className="break-all font-mono text-xs font-medium">{entry.action}</span>
            <Outcome success={entry.success} />
          </div>
          {entry.target ? <p className="break-words text-xs text-muted-foreground">{entry.target}</p> : null}
          <p className="tabular text-xs text-subtle">
            {formatDateTime(entry.at)} · <span className="font-mono">{entry.ip ?? 'IP inconnue'}</span>
            {entry.deviceLabel ? ` · ${entry.deviceLabel}` : ''}
          </p>
        </div>
      )}
    />
  );
}

// ───────────────────────────── Appareils ─────────────────────────────

function DevicesTab() {
  const devices = useDevices();
  const forget = useForgetDevice();
  const [target, setTarget] = useState<KnownDevice | null>(null);

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>Appareils connus</CardTitle>
        <CardDescription>Une connexion depuis un appareil qui ne figure pas ici exige un code de confirmation supplémentaire envoyé par e-mail.</CardDescription>
      </CardHeader>
      <div className="border-t">
        <QueryBoundary
          query={devices}
          skeleton={<RowsSkeleton />}
          isEmpty={(data) => data.length === 0}
          empty={<EmptyState compact icon={MonitorSmartphone} title="Aucun appareil mémorisé" description="Les appareils confirmés lors d'une connexion apparaîtront ici." />}
        >
          {(data) => (
            <ul className="divide-y">
              {data.map((device) => {
                const Icon = deviceIcon(device.label);
                return (
                  <li key={device.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground">
                        <Icon className="size-[18px]" aria-hidden />
                      </span>
                      <div className="flex min-w-0 flex-col gap-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          <span className="break-words">{device.label}</span>
                          {device.current ? <Badge tone="success">Cet appareil</Badge> : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Vu {formatRelative(device.lastSeenAt)}
                          {device.lastIp ? (
                            <>
                              {' '}
                              depuis <span className="font-mono">{device.lastIp}</span>
                            </>
                          ) : null}{' '}
                          · confirmé le {formatDateTime(device.firstSeenAt)}
                        </p>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" className="self-start sm:self-auto" onClick={() => setTarget(device)} disabled={forget.isPending}>
                      Oublier
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryBoundary>
      </div>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => (!open ? setTarget(null) : undefined)}
        title="Oublier cet appareil ?"
        description={`« ${target?.label ?? ''} » devra être confirmé à nouveau par e-mail à sa prochaine connexion. Ses autres sessions ouvertes seront fermées.`}
        confirmLabel="Oublier l'appareil"
        destructive
        onConfirm={() => {
          if (!target) return;
          const device = target;
          setTarget(null);
          forget.mutate(device.id, { onSuccess: () => toast.success('Appareil oublié', { description: device.label }), onError: notifyError('Action impossible') });
        }}
      />
    </Card>
  );
}

// ───────────────────────────── Mot de passe ─────────────────────────────

/** Politique du serveur : ≥ 14 caractères, minuscule, majuscule, chiffre, symbole (et au moins 8 caractères différents). */
function passwordRules(password: string): { label: string; ok: boolean }[] {
  return [
    { label: '14 caractères au minimum', ok: password.length >= 14 },
    { label: 'Une minuscule', ok: /\p{Ll}/u.test(password) },
    { label: 'Une majuscule', ok: /\p{Lu}/u.test(password) },
    { label: 'Un chiffre', ok: /\p{Nd}/u.test(password) },
    { label: 'Un symbole', ok: /[^\p{L}\p{Nd}\s]/u.test(password) },
    { label: '8 caractères différents', ok: new Set(password).size >= 8 },
  ];
}

function strength(password: string, rulesOk: number, rulesTotal: number): { percent: number; label: string; className: string } {
  if (!password) return { percent: 0, label: '', className: 'bg-muted' };
  if (rulesOk < rulesTotal) return { percent: Math.max(8, (rulesOk / rulesTotal) * 60), label: 'Ne respecte pas encore la politique', className: 'bg-danger' };
  if (password.length >= 24) return { percent: 100, label: 'Excellent', className: 'bg-success' };
  if (password.length >= 18) return { percent: 85, label: 'Robuste', className: 'bg-success' };
  return { percent: 70, label: 'Acceptable — une phrase plus longue est encore mieux', className: 'bg-warning' };
}

function PasswordInput({ id, value, onChange, autoComplete, invalid }: { id: string; value: string; onChange: (value: string) => void; autoComplete: string; invalid?: boolean }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input id={id} type={visible ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} maxLength={200} aria-invalid={invalid || undefined} className="pr-11" />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        className="absolute right-0.5 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
        aria-label={visible ? 'Masquer' : 'Afficher'}
        aria-pressed={visible}
      >
        {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  );
}

function PasswordCard() {
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rules = useMemo(() => passwordRules(next), [next]);
  const okCount = rules.filter((rule) => rule.ok).length;
  const meter = strength(next, okCount, rules.length);
  const mismatch = confirm.length > 0 && confirm !== next;
  const valid = current.length > 0 && okCount === rules.length && confirm === next && next !== current;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setError(null);
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          setCurrent('');
          setNext('');
          setConfirm('');
          toast.success('Mot de passe modifié', { description: 'Vos autres sessions ont été fermées.' });
        },
        onError: (cause) => {
          if (isStepUpCancelled(cause)) return;
          if (isApiError(cause) && cause.code === 'INVALID_CREDENTIALS') setCurrent('');
          setError(errorMessage(cause, 'Modification impossible.'));
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="size-4 text-subtle" aria-hidden />
          Mot de passe
        </CardTitle>
        <CardDescription>Le changement ferme toutes vos autres sessions et déclenche une alerte de sécurité.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field id="pw-current" label="Mot de passe actuel">
            <PasswordInput id="pw-current" value={current} onChange={setCurrent} autoComplete="current-password" />
          </Field>
          <Field id="pw-new" label="Nouveau mot de passe" error={next.length > 0 && next === current ? "Doit être différent de l'actuel" : null}>
            <PasswordInput id="pw-new" value={next} onChange={setNext} autoComplete="new-password" />
          </Field>
          <div className="flex flex-col gap-2.5" aria-live="polite">
            <div className="flex items-center gap-3">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" role="presentation">
                <div className={cn('h-full rounded-full transition-[width,background-color] duration-300', meter.className)} style={{ width: `${meter.percent}%` }} />
              </div>
              <span className="min-w-0 shrink text-right text-xs text-muted-foreground">{meter.label || 'Robustesse'}</span>
            </div>
            <ul className="grid grid-cols-1 gap-x-4 gap-y-1 min-[420px]:grid-cols-2">
              {rules.map((rule) => (
                <li key={rule.label} className={cn('flex items-center gap-1.5 text-xs', rule.ok ? 'text-success' : 'text-muted-foreground')}>
                  {rule.ok ? <Check className="size-3.5 shrink-0" aria-hidden /> : <span className="mx-1 size-1.5 shrink-0 rounded-full bg-subtle" aria-hidden />}
                  {rule.label}
                  <span className="sr-only">{rule.ok ? ' : respecté' : ' : manquant'}</span>
                </li>
              ))}
            </ul>
          </div>
          <Field id="pw-confirm" label="Confirmer le nouveau mot de passe" error={mismatch ? 'Les deux saisies ne correspondent pas' : null}>
            <PasswordInput id="pw-confirm" value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={mismatch} />
          </Field>
          {error ? (
            <p role="alert" className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="self-start" disabled={!valid} loading={change.isPending}>
            Changer le mot de passe
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ───────────────────────────── TOTP ─────────────────────────────

function TotpCard() {
  const regenerate = useRegenerateTotp();
  const confirmTotp = useConfirmTotp();
  const [confirmStart, setConfirmStart] = useState(false);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  // L'image du QR code vient de l'API : n'est affichée que si c'est bien une image PNG en data: URL.
  const qr = setup && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(setup.qrDataUrl) ? setup.qrDataUrl : null;

  const start = () => {
    setConfirmStart(false);
    regenerate.mutate(undefined, {
      onSuccess: (data) => {
        setSetup(data);
        setCode('');
        setError(null);
      },
      onError: notifyError('Régénération impossible'),
    });
  };

  const submit = (value: string) => {
    if (value.length !== 6 || confirmTotp.isPending) return;
    setError(null);
    confirmTotp.mutate(value, {
      onSuccess: () => {
        setSetup(null);
        toast.success('Double authentification mise à jour', { description: "L'ancien secret ne fonctionne plus. Vos autres sessions ont été fermées." });
      },
      onError: (cause) => {
        setCode('');
        setError(isApiError(cause) && cause.code === 'INVALID_CREDENTIALS' ? 'Code incorrect. Vérifiez que vous avez bien scanné le nouveau QR code, puis saisissez le code affiché.' : errorMessage(cause, 'Confirmation impossible.'));
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <QrCode className="size-4 text-subtle" aria-hidden />
          Application d'authentification (TOTP)
        </CardTitle>
        <CardDescription>Remplacez le secret 2FA si vous changez de téléphone ou en cas de doute. Le nouveau secret n'est activé qu'après confirmation par un code.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" onClick={() => setConfirmStart(true)} loading={regenerate.isPending}>
          <Fingerprint aria-hidden />
          Régénérer le secret 2FA
        </Button>
      </CardContent>

      <ConfirmDialog
        open={confirmStart}
        onOpenChange={setConfirmStart}
        title="Régénérer le secret 2FA ?"
        description="Un nouveau QR code va être affiché. Tant que vous ne l'avez pas confirmé avec un code, votre secret actuel reste valable."
        confirmLabel="Afficher le nouveau QR code"
        onConfirm={start}
      />

      <Dialog open={setup !== null} onOpenChange={(open) => (!open && !confirmTotp.isPending ? setSetup(null) : undefined)}>
        <DialogContent className="max-w-md" onInteractOutside={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Configurer le nouveau secret</DialogTitle>
            <DialogDescription>1. Scannez ce QR code avec votre application (Aegis, 2FAS, Google Authenticator…). 2. Saisissez le code à 6 chiffres qu'elle affiche.</DialogDescription>
          </DialogHeader>
          {setup ? (
            <div className="flex flex-col items-center gap-4">
              {qr ? (
                <img src={qr} alt="QR code du nouveau secret 2FA" width={208} height={208} className="rounded-xl border bg-white p-2" />
              ) : (
                <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">QR code indisponible : saisissez la clé manuellement.</p>
              )}
              <div className="flex w-full flex-col gap-1.5">
                <p className="text-xs text-muted-foreground">Saisie manuelle de la clé :</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-md border bg-muted px-2.5 py-2 font-mono text-xs">{setup.secret}</code>
                  <CopyButton value={setup.secret} />
                </div>
              </div>
              <form
                className="flex w-full flex-col items-center gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit(code);
                }}
              >
                <CodeInput
                  length={6}
                  value={code}
                  onChange={(value) => {
                    setCode(value);
                    if (error) setError(null);
                  }}
                  onComplete={submit}
                  disabled={confirmTotp.isPending}
                  invalid={error !== null}
                  autoFocus
                  aria-label="Code à 6 chiffres du nouveau secret"
                />
                {error ? (
                  <p role="alert" className="text-center text-[13px] text-danger">
                    {error}
                  </p>
                ) : null}
                <DialogFooter className="w-full">
                  <Button variant="outline" onClick={() => setSetup(null)} disabled={confirmTotp.isPending}>
                    Annuler
                  </Button>
                  <Button type="submit" disabled={code.length !== 6} loading={confirmTotp.isPending}>
                    Activer ce secret
                  </Button>
                </DialogFooter>
              </form>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ───────────────────────────── Codes de secours ─────────────────────────────

function BackupCodesCard() {
  const status = useBackupCodesStatus();
  const regenerate = useRegenerateBackupCodes();
  const [confirm, setConfirm] = useState(false);
  const [codes, setCodes] = useState<BackupCodes | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const remaining = status.data?.remaining ?? 0;
  const total = status.data?.total ?? 0;
  const low = status.data !== undefined && remaining <= 3;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LifeBuoy className="size-4 text-subtle" aria-hidden />
          Codes de secours
        </CardTitle>
        <CardDescription>À utiliser à la place du code 2FA si vous perdez votre téléphone. Chaque code ne sert qu'une fois.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status.data ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm">
                <span className="tabular text-2xl font-semibold">{remaining}</span>
                <span className="text-muted-foreground"> / {total} codes restants</span>
              </p>
              {low ? (
                <Badge tone={remaining === 0 ? 'danger' : 'warning'}>
                  <TriangleAlert className="size-3" aria-hidden />
                  {remaining === 0 ? 'Aucun code' : 'Bientôt épuisés'}
                </Badge>
              ) : null}
            </div>
            <Progress value={total > 0 ? (remaining / total) * 100 : 0} indicatorClassName={remaining === 0 ? 'bg-danger' : low ? 'bg-warning' : undefined} aria-label="Codes de secours restants" />
          </div>
        ) : status.isError ? (
          <p className="text-[13px] text-danger">Nombre de codes restants indisponible.</p>
        ) : (
          <Skeleton className="h-12" />
        )}
        <Button variant="outline" className="self-start" onClick={() => setConfirm(true)} loading={regenerate.isPending}>
          <KeyRound aria-hidden />
          Générer de nouveaux codes
        </Button>
      </CardContent>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Générer de nouveaux codes de secours ?"
        description="Les codes actuels cesseront immédiatement de fonctionner. Les nouveaux codes ne seront affichés qu'une seule fois."
        confirmLabel="Générer"
        destructive
        onConfirm={() => {
          setConfirm(false);
          regenerate.mutate(undefined, {
            onSuccess: (data) => {
              setAcknowledged(false);
              setCodes(data);
            },
            onError: notifyError('Génération impossible'),
          });
        }}
      />

      <Dialog open={codes !== null} onOpenChange={(open) => (!open && acknowledged ? setCodes(null) : undefined)}>
        <DialogContent className="max-w-md" hideClose onInteractOutside={(event) => event.preventDefault()} onEscapeKeyDown={(event) => event.preventDefault()}>
          <DialogHeader className="pr-0">
            <DialogTitle>Vos nouveaux codes de secours</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-warning">Ils ne seront plus jamais affichés.</span> Conservez-les dans un gestionnaire de mots de passe ou imprimez-les, à l'écart de votre téléphone.
            </DialogDescription>
          </DialogHeader>
          {codes ? (
            <>
              <ul className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/40 p-3" aria-label="Codes de secours">
                {codes.codes.map((item) => (
                  <li key={item} className="tabular select-all rounded-md bg-card px-2 py-1.5 text-center font-mono text-[13px] tracking-wide">
                    {item}
                  </li>
                ))}
              </ul>
              <DialogFooter className="sm:justify-between">
                <CopyButton value={codes.codes.join('\n')} label="Copier tous les codes" size="default" onPointerUp={() => setAcknowledged(true)} />
                <Button
                  onClick={() => {
                    setAcknowledged(true);
                    setCodes(null);
                  }}
                >
                  J'ai enregistré mes codes
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ───────────────────────────── Liste blanche d'IP ─────────────────────────────

const IP_OR_CIDR = /^(?:(?:\d{1,3}\.){3}\d{1,3}(?:\/(?:3[0-2]|[12]?\d))?|[0-9a-fA-F:]{2,39}(?:\/(?:12[0-8]|1[01]\d|\d{1,2}))?)$/;

function AllowlistCard() {
  const allowlist = useIpAllowlist();
  const update = useUpdateAllowlist();
  const [entries, setEntries] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const saved = allowlist.data?.entries;

  useEffect(() => {
    if (saved) setEntries(saved);
  }, [saved]);

  const add = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    if (!IP_OR_CIDR.test(value)) return setDraftError('Entrez une adresse IP ou un bloc CIDR (ex. 203.0.113.7 ou 203.0.113.0/24).');
    if (!entries.includes(value)) setEntries([...entries, value]);
    setDraft('');
    setDraftError(null);
    setError(null);
  };

  const save = () => {
    setConfirm(false);
    setError(null);
    update.mutate(entries, {
      onSuccess: (data) => {
        setEntries(data.entries);
        toast.success("Liste blanche d'IP enregistrée", { description: data.entries.length === 0 && data.envEntries.length === 0 ? 'Filtrage désactivé : toutes les adresses sont acceptées.' : undefined });
      },
      onError: (cause) => {
        if (isStepUpCancelled(cause)) return;
        const invalid = isApiError(cause) && isRecord(cause.details) && Array.isArray(cause.details.invalid) ? cause.details.invalid.filter((item): item is string => typeof item === 'string') : [];
        setError(invalid.length > 0 ? `Entrées refusées : ${invalid.join(', ')}` : errorMessage(cause, 'Enregistrement impossible.'));
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="size-4 text-subtle" aria-hidden />
          Liste blanche d'adresses IP
        </CardTitle>
        <CardDescription>Si la liste contient au moins une entrée, seules ces adresses peuvent atteindre le panel. Elle s'applique aux deux administrateurs.</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryBoundary query={allowlist} compact skeleton={<Skeleton className="h-40" />}>
          {(data) => {
            const dirty = JSON.stringify(entries) !== JSON.stringify(data.entries);
            const active = entries.length > 0 || data.envEntries.length > 0;
            const hasCurrent = entries.includes(data.currentIp);
            return (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-2.5">
                  <p className="text-[13px]">
                    <span className="text-muted-foreground">Votre adresse IP actuelle : </span>
                    <span className="font-mono font-medium">{data.currentIp}</span>
                  </p>
                  <Button variant="outline" size="sm" onClick={() => add(data.currentIp)} disabled={hasCurrent}>
                    {hasCurrent ? <Check aria-hidden /> : <Plus aria-hidden />}
                    {hasCurrent ? 'Déjà dans la liste' : 'Ajouter mon IP'}
                  </Button>
                </div>

                <div className="flex gap-3 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2.5 text-[13px] leading-relaxed">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <p>
                    <span className="font-medium">Risque d'enfermement.</span>{' '}
                    <span className="text-muted-foreground">
                      Si votre adresse change (box, 4G, déplacement) et qu'elle n'est pas dans la liste, vous ne pourrez plus ouvrir le panel : il faudra alors corriger la liste depuis la ligne de commande du serveur.
                      Vérifiez que votre IP actuelle y figure avant d'enregistrer.
                    </span>
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <p className="text-[13px] font-medium">Adresses autorisées</p>
                  {entries.length === 0 ? (
                    <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[13px] text-muted-foreground">
                      {data.envEntries.length > 0 ? 'Aucune entrée gérée depuis le panel.' : 'Liste vide : le filtrage par IP est désactivé, toutes les adresses sont acceptées.'}
                    </p>
                  ) : (
                    <ul className="flex flex-wrap gap-2">
                      {entries.map((entry) => (
                        <li key={entry} className="inline-flex h-9 items-center gap-1 rounded-md border bg-card pl-2.5 pr-0.5 font-mono text-[13px]">
                          {entry}
                          {entry === data.currentIp ? <Badge tone="success" className="ml-1 font-sans">vous</Badge> : null}
                          <button type="button" onClick={() => setEntries(entries.filter((item) => item !== entry))} className="inline-flex size-8 items-center justify-center rounded text-muted-foreground hover:text-danger" aria-label={`Retirer ${entry}`}>
                            <X className="size-3.5" aria-hidden />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {data.envEntries.length > 0 ? (
                    <div className="flex flex-col gap-1.5 pt-1">
                      <p className="text-xs text-muted-foreground">Imposées par la configuration du serveur (variable IP_ALLOWLIST, non modifiables ici) :</p>
                      <ul className="flex flex-wrap gap-2">
                        {data.envEntries.map((entry) => (
                          <li key={entry} className="inline-flex h-8 items-center rounded-md border border-dashed bg-muted/40 px-2.5 font-mono text-xs text-muted-foreground">
                            {entry}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>

                <form
                  className="flex flex-col gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    add(draft);
                  }}
                >
                  <label htmlFor="allowlist-add" className="text-[13px] font-medium">
                    Ajouter une adresse ou un bloc
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id="allowlist-add"
                      value={draft}
                      onChange={(event) => {
                        setDraft(event.target.value);
                        if (draftError) setDraftError(null);
                      }}
                      placeholder="203.0.113.7 ou 203.0.113.0/24"
                      maxLength={64}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={draftError !== null}
                      className="max-w-xs font-mono"
                    />
                    <Button type="submit" variant="outline" disabled={!draft.trim()}>
                      Ajouter
                    </Button>
                  </div>
                  {draftError ? (
                    <p role="alert" className="text-xs text-danger">
                      {draftError}
                    </p>
                  ) : null}
                </form>

                {error ? (
                  <p role="alert" className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[13px] text-danger">
                    {error}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                  <Button onClick={() => setConfirm(true)} disabled={!dirty} loading={update.isPending}>
                    Enregistrer la liste
                  </Button>
                  <Button variant="ghost" onClick={() => setEntries(data.entries)} disabled={!dirty || update.isPending}>
                    Annuler les modifications
                  </Button>
                  <span className="ml-auto text-xs text-muted-foreground">{active ? 'Filtrage actif après enregistrement' : 'Filtrage désactivé'}</span>
                </div>

                <ConfirmDialog
                  open={confirm}
                  onOpenChange={setConfirm}
                  title="Enregistrer la liste blanche ?"
                  description={
                    entries.length === 0 ? (
                      'La liste gérée depuis le panel sera vide.'
                    ) : (
                      <div className="flex flex-col gap-2">
                        <p>
                          Seules ces {entries.length} entrée{entries.length > 1 ? 's' : ''} pourront accéder au panel{data.envEntries.length > 0 ? ' (en plus de celles imposées par le serveur)' : ''}.
                        </p>
                        {hasCurrent ? null : (
                          <p className="font-medium text-warning">
                            Votre IP actuelle ({data.currentIp}) n'apparaît pas telle quelle dans la liste. Si aucun bloc ne la couvre, l'enregistrement sera refusé.
                          </p>
                        )}
                      </div>
                    )
                  }
                  confirmLabel="Enregistrer"
                  destructive={entries.length > 0}
                  onConfirm={save}
                />
              </div>
            );
          }}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

// ───────────────────────────── Page ─────────────────────────────

const TABS: { value: string; label: string; icon: typeof History; content: () => ReactNode }[] = [
  { value: 'sessions', label: 'Sessions', icon: MonitorSmartphone, content: () => <SessionsTab /> },
  { value: 'journal', label: 'Journal', icon: History, content: () => <AuditTab /> },
  { value: 'appareils', label: 'Appareils', icon: Laptop, content: () => <DevicesTab /> },
  {
    value: 'authentification',
    label: 'Authentification',
    icon: KeyRound,
    content: () => (
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <PasswordCard />
        <div className="flex flex-col gap-4">
          <TotpCard />
          <BackupCodesCard />
        </div>
      </div>
    ),
  },
  { value: 'ip', label: "Liste blanche d'IP", icon: Globe, content: () => <AllowlistCard /> },
];

export default function SecurityPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab = TABS.some((item) => item.value === requested) ? (requested as string) : 'sessions';

  return (
    <Page>
      <PageHeader title="Sécurité" description="Sessions, journal d'activité, appareils, mot de passe, double authentification et filtrage par adresse IP." />
      <Tabs value={tab} onValueChange={(value) => setParams(value === 'sessions' ? {} : { tab: value }, { replace: true })}>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList>
            {TABS.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                <item.icon aria-hidden />
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {TABS.map((item) => (
          <TabsContent key={item.value} value={item.value}>
            {item.content()}
          </TabsContent>
        ))}
      </Tabs>
    </Page>
  );
}
