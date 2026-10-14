import type { MailAccount, MailAccountInput, SettingsTestResult } from '@shared/api-types';
import { FlaskConical, Inbox, Mail, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Field } from '@/components/shared/misc';
import { EmptyState, ErrorState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useDeleteMailAccount, useMailAccounts, useSaveMailAccount, useTestMailAccount } from '@/features/mail/api';
import { HelpDisclosure, SectionShell, TestResult } from '@/features/settings/integration-section';
import { errorMessage, isApiError, isStepUpCancelled } from '@/lib/api';
import { isRecord } from '@/lib/utils';

interface FormState {
  label: string;
  address: string;
  username: string;
  password: string;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
}

const emptyForm = (): FormState => ({ label: '', address: '', username: '', password: '', imapHost: '', imapPort: '993', imapSecure: true, smtpHost: '', smtpPort: '465', smtpSecure: true });
const toForm = (account: MailAccount): FormState => ({
  label: account.label,
  address: account.address,
  username: account.username,
  password: '',
  imapHost: account.imapHost,
  imapPort: String(account.imapPort),
  imapSecure: account.imapSecure,
  smtpHost: account.smtpHost,
  smtpPort: String(account.smtpPort),
  smtpSecure: account.smtpSecure,
});

const validPort = (value: string): boolean => /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65_535;

function AccountForm({ open, account, onClose }: { open: boolean; account: MailAccount | null; onClose: () => void }) {
  const save = useSaveMailAccount();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(account ? toForm(account) : emptyForm());
      setErrors({});
      setFormError(null);
    }
  }, [open, account]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors(({ [key]: _removed, ...rest }) => rest);
  };

  // Le serveur exige de ressaisir le mot de passe si l'hôte IMAP ou SMTP change (il ne doit pas partir vers un autre serveur).
  const hostChanged = account !== null && (form.imapHost.trim().toLowerCase() !== account.imapHost.toLowerCase() || form.smtpHost.trim().toLowerCase() !== account.smtpHost.toLowerCase());
  const passwordRequired = account === null || hostChanged;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!form.label.trim()) next.label = 'Donnez un nom à ce compte';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.address.trim())) next.address = 'Adresse e-mail invalide';
    if (!form.username.trim() || /\s/.test(form.username.trim())) next.username = "Identifiant requis (sans espace)";
    if (!form.imapHost.trim()) next.imapHost = 'Hôte IMAP requis';
    if (!form.smtpHost.trim()) next.smtpHost = 'Hôte SMTP requis';
    if (!validPort(form.imapPort)) next.imapPort = 'Port invalide';
    if (!validPort(form.smtpPort)) next.smtpPort = 'Port invalide';
    if (passwordRequired && !form.password) next.password = hostChanged ? "L'hôte a changé : ressaisissez le mot de passe" : 'Mot de passe requis';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    // Corps strict : uniquement les champs du contrat ; mot de passe omis s'il n'est pas ressaisi.
    const input: MailAccountInput = {
      label: form.label.trim(),
      address: form.address.trim(),
      imapHost: form.imapHost.trim(),
      imapPort: Number(form.imapPort),
      imapSecure: form.imapSecure,
      smtpHost: form.smtpHost.trim(),
      smtpPort: Number(form.smtpPort),
      smtpSecure: form.smtpSecure,
      username: form.username.trim(),
    };
    if (form.password) input.password = form.password;

    setFormError(null);
    save.mutate(
      { id: account?.id ?? null, input },
      {
        onSuccess: () => {
          toast.success(account ? 'Compte mail mis à jour' : 'Compte mail ajouté', { description: input.address });
          onClose();
        },
        onError: (error) => {
          if (isStepUpCancelled(error)) return;
          if (isApiError(error) && error.code === 'VALIDATION_ERROR' && isRecord(error.details)) {
            const mapped: Partial<Record<keyof FormState, string>> = {};
            for (const [key, messages] of Object.entries(error.details)) {
              if (key in form && Array.isArray(messages) && typeof messages[0] === 'string') mapped[key as keyof FormState] = messages[0];
            }
            if (Object.keys(mapped).length > 0) return setErrors(mapped);
          }
          setFormError(errorMessage(error, 'Enregistrement impossible.'));
        },
      },
    );
  };

  return (
    <Sheet open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <SheetContent className="max-w-lg">
        <SheetHeader>
          <SheetTitle>{account ? 'Modifier le compte mail' : 'Ajouter un compte mail'}</SheetTitle>
          <SheetDescription>Connexion IMAP (lecture) et SMTP (envoi). Le mot de passe est chiffré sur le serveur et n'est jamais renvoyé.</SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col" noValidate>
          <SheetBody className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="mail-label" label="Nom du compte" error={errors.label} hint="Ex. Support, Contact, Facturation.">
                <Input id="mail-label" value={form.label} onChange={(event) => set('label', event.target.value)} maxLength={60} placeholder="Support" aria-invalid={Boolean(errors.label)} autoComplete="off" />
              </Field>
              <Field id="mail-address" label="Adresse e-mail" error={errors.address}>
                <Input id="mail-address" type="email" value={form.address} onChange={(event) => set('address', event.target.value)} maxLength={254} placeholder="support@exemple.com" aria-invalid={Boolean(errors.address)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="mail-username" label="Identifiant" error={errors.username} hint="Souvent l'adresse e-mail complète.">
                <Input id="mail-username" value={form.username} onChange={(event) => set('username', event.target.value)} maxLength={255} aria-invalid={Boolean(errors.username)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
              </Field>
              <Field
                id="mail-password"
                label="Mot de passe"
                error={errors.password}
                hint={
                  account ? (
                    hostChanged ? (
                      <span className="text-warning">L'hôte IMAP ou SMTP a changé : le mot de passe doit être ressaisi.</span>
                    ) : (
                      <>
                        <span className="font-medium text-success">{account.hasPassword ? 'Défini' : 'Non défini'}</span> — laissez vide pour ne pas le modifier.
                      </>
                    )
                  ) : (
                    "Utilisez un mot de passe d'application si votre fournisseur le propose."
                  )
                }
              >
                <Input
                  id="mail-password"
                  type="password"
                  value={form.password}
                  onChange={(event) => set('password', event.target.value)}
                  maxLength={1024}
                  placeholder={account && !hostChanged ? '•••••••••••• (inchangé)' : undefined}
                  aria-invalid={Boolean(errors.password)}
                  autoComplete="new-password"
                />
              </Field>
            </div>

            {(['imap', 'smtp'] as const).map((kind) => {
              const hostKey = `${kind}Host` as const;
              const portKey = `${kind}Port` as const;
              const secureKey = `${kind}Secure` as const;
              const upper = kind.toUpperCase();
              return (
                <fieldset key={kind} className="flex flex-col gap-3 rounded-lg border p-3">
                  <legend className="px-1 text-[13px] font-medium">
                    {upper} <span className="font-normal text-muted-foreground">— {kind === 'imap' ? 'réception' : 'envoi'}</span>
                  </legend>
                  <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
                    <Field id={`mail-${hostKey}`} label="Serveur" error={errors[hostKey]}>
                      <Input
                        id={`mail-${hostKey}`}
                        value={form[hostKey]}
                        onChange={(event) => set(hostKey, event.target.value)}
                        maxLength={253}
                        placeholder={kind === 'imap' ? 'imap.exemple.com' : 'smtp.exemple.com'}
                        aria-invalid={Boolean(errors[hostKey])}
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                      />
                    </Field>
                    <Field id={`mail-${portKey}`} label="Port" error={errors[portKey]}>
                      <Input id={`mail-${portKey}`} value={form[portKey]} onChange={(event) => set(portKey, event.target.value.replace(/\D/g, '').slice(0, 5))} inputMode="numeric" aria-invalid={Boolean(errors[portKey])} className="tabular" autoComplete="off" />
                    </Field>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor={`mail-${secureKey}`} className="flex flex-col gap-1 font-normal">
                      <span className="font-medium">TLS implicite</span>
                      <span className="text-xs leading-snug text-muted-foreground">
                        {kind === 'imap' ? 'Activé pour le port 993 ; désactivé = STARTTLS (143).' : 'Activé pour le port 465 ; désactivé = STARTTLS (587).'}
                      </span>
                    </Label>
                    <Switch id={`mail-${secureKey}`} checked={form[secureKey]} onCheckedChange={(checked) => set(secureKey, checked)} />
                  </div>
                </fieldset>
              );
            })}

            {formError ? (
              <p role="alert" className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[13px] text-danger">
                {formError}
              </p>
            ) : null}
          </SheetBody>
          <SheetFooter>
            <Button variant="outline" onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" loading={save.isPending}>
              {account ? 'Enregistrer' : 'Ajouter le compte'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** Section « Comptes mail » des réglages : liste, ajout, modification, suppression (2FA) et test IMAP/SMTP. */
export function MailAccountsSection() {
  const accounts = useMailAccounts();
  const remove = useDeleteMailAccount();
  const test = useTestMailAccount();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MailAccount | null>(null);
  const [deleting, setDeleting] = useState<MailAccount | null>(null);
  const [results, setResults] = useState<Record<number, SettingsTestResult>>({});
  const [testing, setTesting] = useState<number | null>(null);

  const runTest = (account: MailAccount) => {
    setTesting(account.id);
    setResults(({ [account.id]: _removed, ...rest }) => rest);
    test.mutate(account.id, {
      onSuccess: (result) => setResults((current) => ({ ...current, [account.id]: { ok: result.ok === true, message: typeof result.message === 'string' ? result.message : '' } })),
      onError: (error) => {
        if (!isStepUpCancelled(error)) setResults((current) => ({ ...current, [account.id]: { ok: false, message: errorMessage(error, 'Test impossible.') } }));
      },
      onSettled: () => setTesting(null),
    });
  };

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  return (
    <SectionShell
      id="mail"
      icon={Mail}
      title="Comptes mail"
      description="Boîtes IMAP/SMTP consultées depuis la page Mails (support, contact, facturation…)."
      badge={accounts.data ? accounts.data.length > 0 ? <Badge tone="success">{accounts.data.length} compte{accounts.data.length > 1 ? 's' : ''}</Badge> : <Badge>Aucun compte</Badge> : undefined}
    >
      {accounts.data ? (
        accounts.data.length === 0 ? (
          <EmptyState
            compact
            icon={Inbox}
            title="Aucun compte mail"
            description="Ajoutez une première boîte pour lire et répondre à vos mails depuis le panel."
            action={
              <Button size="sm" onClick={openCreate}>
                <Plus aria-hidden />
                Ajouter un compte
              </Button>
            }
          />
        ) : (
          <>
            <ul className="flex flex-col gap-3">
              {accounts.data.map((account) => (
                <li key={account.id} className="flex flex-col gap-3 rounded-lg border p-3 sm:p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className="break-words">{account.label}</span>
                        {account.hasPassword ? null : <Badge tone="warning">Mot de passe manquant</Badge>}
                      </p>
                      <p className="break-all text-[13px] text-muted-foreground">{account.address}</p>
                      <p className="break-all font-mono text-xs text-subtle">
                        IMAP {account.imapHost}:{account.imapPort} · SMTP {account.smtpHost}:{account.smtpPort}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button variant="outline" size="sm" onClick={() => runTest(account)} loading={testing === account.id} disabled={testing !== null && testing !== account.id}>
                        {testing === account.id ? null : <FlaskConical aria-hidden />}
                        <span className="hidden sm:inline">Tester la connexion</span>
                        <span className="sm:hidden">Tester</span>
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions pour ${account.label}`}>
                            <MoreHorizontal aria-hidden />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => {
                              setEditing(account);
                              setFormOpen(true);
                            }}
                          >
                            <Pencil aria-hidden />
                            Modifier
                          </DropdownMenuItem>
                          <DropdownMenuItem destructive onSelect={() => setDeleting(account)}>
                            <Trash2 aria-hidden />
                            Supprimer
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  <TestResult result={results[account.id] ?? null} />
                </li>
              ))}
            </ul>
            <Button variant="outline" className="self-start" onClick={openCreate}>
              <Plus aria-hidden />
              Ajouter un compte
            </Button>
          </>
        )
      ) : accounts.isError ? (
        <ErrorState compact error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : (
        <div className="flex flex-col gap-3" aria-busy aria-label="Chargement des comptes mail">
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
        </div>
      )}

      <HelpDisclosure title="Quels paramètres utiliser ?">
        <p>
          Les paramètres IMAP et SMTP sont donnés par votre hébergeur de messagerie (cPanel : <strong>Comptes de messagerie › Connecter des périphériques</strong> ; OVH, Infomaniak, Google Workspace : aide «
          configuration IMAP »).
        </p>
        <ol>
          <li>
            Réception : <code>IMAP</code>, port <code>993</code> avec TLS implicite.
          </li>
          <li>
            Envoi : <code>SMTP</code>, port <code>465</code> avec TLS implicite, ou <code>587</code> en STARTTLS (TLS implicite désactivé).
          </li>
          <li>Avec la double authentification chez votre fournisseur, créez un « mot de passe d'application » dédié au panel.</li>
        </ol>
      </HelpDisclosure>

      <AccountForm open={formOpen} account={editing} onClose={() => setFormOpen(false)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (!open ? setDeleting(null) : undefined)}
        title="Supprimer ce compte mail ?"
        description={`« ${deleting?.label ?? ''} » (${deleting?.address ?? ''}) ne sera plus consultable depuis le panel. Les messages restent sur le serveur de messagerie.`}
        confirmLabel="Supprimer le compte"
        destructive
        onConfirm={() => {
          if (!deleting) return;
          const account = deleting;
          setDeleting(null);
          remove.mutate(account.id, {
            onSuccess: () => toast.success('Compte mail supprimé', { description: account.address }),
            onError: (error) => {
              if (!isStepUpCancelled(error)) toast.error('Suppression impossible', { description: errorMessage(error) });
            },
          });
        }}
      />
    </SectionShell>
  );
}
