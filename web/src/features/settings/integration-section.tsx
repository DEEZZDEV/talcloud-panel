import type { SettingsTestResult, SettingsView } from '@shared/api-types';
import { ChevronDown, CircleCheck, CircleX, FlaskConical, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Field } from '@/components/shared/misc';
import { ErrorState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useSaveSettings, useSettings, useTestSettings, type SettingsNamespace } from '@/features/settings/api';
import { errorMessage, isApiError, isStepUpCancelled } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn, isRecord } from '@/lib/utils';

export interface SettingsField {
  name: string;
  label: string;
  kind: 'text' | 'url' | 'secret' | 'switch' | 'textarea';
  placeholder?: string;
  /** Aide courte sous le champ : où trouver la valeur. */
  help?: ReactNode;
  optional?: boolean;
  defaultValue?: string | boolean;
}

type Values = Record<string, string | boolean>;

const RETYPE_MESSAGE = "L'adresse change : ressaisissez cette clé pour confirmer.";

export function ConfiguredBadge({ configured }: { configured: boolean }) {
  return configured ? (
    <Badge tone="success">
      <CircleCheck className="size-3" aria-hidden />
      Configuré
    </Badge>
  ) : (
    <Badge>Non configuré</Badge>
  );
}

/** Résultat d'un test de connexion (le message vient du serveur : rendu en texte). */
export function TestResult({ result }: { result: SettingsTestResult | null }) {
  if (!result) return null;
  return (
    <p
      role="status"
      className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] leading-relaxed', result.ok ? 'border-success/20 bg-success/10 text-success' : 'border-danger/25 bg-danger/10 text-danger')}
    >
      {result.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <span className="break-words">{result.message}</span>
    </p>
  );
}

/** Aide contextuelle repliable : « où trouver ces informations ? ». */
export function HelpDisclosure({ title = 'Où trouver ces informations ?', children }: { title?: string; children: ReactNode }) {
  return (
    <details className="group rounded-lg border bg-muted/40 text-[13px]">
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-3 font-medium [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="flex flex-col gap-2 border-t px-3 py-3 leading-relaxed text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:text-foreground [&_li]:ml-4 [&_ol]:list-decimal [&_strong]:font-medium [&_strong]:text-foreground">
        {children}
      </div>
    </details>
  );
}

export function SectionShell({
  id,
  icon: Icon,
  title,
  description,
  badge,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-20" aria-labelledby={`${id}-title`} role="region">
      <div className="flex items-start gap-3 border-b p-4 sm:p-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted text-foreground">
          <Icon className="size-[18px]" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h2 id={`${id}-title`} className="text-[15px] font-semibold leading-tight">
              {title}
            </h2>
            {badge}
          </div>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex flex-col gap-5 p-4 sm:p-5">{children}</div>
    </Card>
  );
}

interface IntegrationSectionProps {
  namespace: SettingsNamespace;
  icon: LucideIcon;
  title: string;
  description: string;
  fields: SettingsField[];
  help: ReactNode;
  testLabel?: string;
  /**
   * Champs dont la modification oblige à ressaisir les secrets déjà enregistrés (URL, options TLS) :
   * le serveur refuse d'envoyer des clés existantes vers une nouvelle destination sans confirmation.
   */
  rekeyOn?: readonly string[];
  /** Contenu supplémentaire inséré dans le formulaire (éditeurs spécifiques) : reçoit les valeurs non standard. */
  extra?: (context: { view: SettingsView<Record<string, unknown>>; setExtra: (name: string, value: unknown) => void; extraValues: Record<string, unknown> }) => ReactNode;
  /** Bloc affiché sous le formulaire (ex. notifications push). */
  footer?: ReactNode;
}

const initialValues = (fields: SettingsField[], view: SettingsView<Record<string, unknown>>): Values => {
  const values: Values = {};
  for (const field of fields) {
    // Un secret n'est JAMAIS prérempli : l'API ne le renvoie pas, et un champ vide signifie « inchangé ».
    if (field.kind === 'secret') values[field.name] = '';
    else if (field.kind === 'switch') {
      const stored = view.values[field.name];
      values[field.name] = typeof stored === 'boolean' ? stored : field.defaultValue === true;
    } else {
      const stored = view.values[field.name];
      values[field.name] = typeof stored === 'string' ? stored : typeof field.defaultValue === 'string' ? field.defaultValue : '';
    }
  }
  return values;
};

/** Section de réglages d'une intégration : état, formulaire (secrets jamais préremplis), test de connexion, aide. */
export function IntegrationSection({ namespace, icon, title, description, fields, help, testLabel = 'Tester la connexion', rekeyOn, extra, footer }: IntegrationSectionProps) {
  const settings = useSettings<Record<string, unknown>>(namespace);
  const save = useSaveSettings<Record<string, unknown>>(namespace);
  const test = useTestSettings(namespace);
  const [values, setValues] = useState<Values>({});
  const [extraValues, setExtraValues] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<SettingsTestResult | null>(null);
  const view = settings.data;

  const baseline = useMemo(() => (view ? initialValues(fields, view) : null), [fields, view]);
  useEffect(() => {
    if (baseline) {
      setValues(baseline);
      setExtraValues({});
      setFieldErrors({});
      setFormError(null);
    }
  }, [baseline]);

  const dirty = baseline !== null && (fields.some((field) => values[field.name] !== baseline[field.name]) || Object.keys(extraValues).length > 0);

  // La destination change alors que des clés existent : elles doivent être ressaisies dans la même requête.
  const destinationChanged = baseline !== null && (rekeyOn ?? []).some((name) => values[name] !== baseline[name]);
  const mustRetype = (name: string): boolean => destinationChanged && view?.secrets[name] === true;

  const set = (name: string, value: string | boolean) => {
    setValues((current) => ({ ...current, [name]: value }));
    if (fieldErrors[name]) setFieldErrors(({ [name]: _removed, ...rest }) => rest);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!view) return;
    setFormError(null);
    setFieldErrors({});
    const missing = fields.filter((field) => field.kind === 'secret' && mustRetype(field.name) && String(values[field.name] ?? '').trim() === '');
    if (missing.length > 0) {
      setFieldErrors(Object.fromEntries(missing.map((field) => [field.name, RETYPE_MESSAGE])));
      setFormError("L'adresse ou les options de connexion changent : ressaisissez les clés pour confirmer.");
      return;
    }
    // Corps partiel : valeurs non secrètes, et secrets uniquement s'ils ont été ressaisis.
    const body: Record<string, unknown> = { ...extraValues };
    for (const field of fields) {
      const value = values[field.name];
      if (field.kind === 'secret') {
        if (typeof value === 'string' && value.trim() !== '') body[field.name] = value.trim();
      } else if (field.kind === 'switch') {
        body[field.name] = value === true;
      } else {
        const text = typeof value === 'string' ? value.trim() : '';
        // Champ facultatif vidé → clé supprimée côté serveur.
        body[field.name] = text === '' && field.optional ? null : text;
      }
    }
    save.mutate(body, {
      onSuccess: () => {
        setTestResult(null);
        toast.success(`${title} : réglages enregistrés`);
      },
      onError: (error) => {
        if (isStepUpCancelled(error)) return;
        if (isApiError(error) && error.code === 'VALIDATION_ERROR' && isRecord(error.details) && Array.isArray(error.details.secretsRequired)) {
          const required = error.details.secretsRequired.filter((name): name is string => typeof name === 'string');
          setFieldErrors(Object.fromEntries(required.map((name) => [name, RETYPE_MESSAGE])));
          setFormError("L'adresse ou les options de connexion changent : ressaisissez les clés pour confirmer.");
          return;
        }
        if (isApiError(error) && error.code === 'VALIDATION_ERROR' && isRecord(error.details)) {
          const mapped: Record<string, string> = {};
          for (const [key, messages] of Object.entries(error.details)) {
            if (Array.isArray(messages) && typeof messages[0] === 'string') mapped[key] = messages[0];
          }
          if (Object.keys(mapped).length > 0) {
            setFieldErrors(mapped);
            const unknown = Object.entries(mapped).filter(([key]) => !fields.some((field) => field.name === key));
            setFormError(unknown.length > 0 ? unknown.map(([key, message]) => `${key} : ${message}`).join(' · ') : 'Certains champs sont invalides.');
            return;
          }
        }
        setFormError(errorMessage(error, 'Enregistrement impossible.'));
      },
    });
  };

  const runTest = () => {
    setTestResult(null);
    test.mutate(undefined, {
      onSuccess: setTestResult,
      onError: (error) => {
        if (!isStepUpCancelled(error)) setTestResult({ ok: false, message: errorMessage(error, 'Test impossible.') });
      },
    });
  };

  return (
    <SectionShell id={namespace} icon={icon} title={title} description={description} badge={view ? <ConfiguredBadge configured={view.configured} /> : undefined}>
      {view && baseline ? (
        <>
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {fields.map((field) => {
                const id = `${namespace}-${field.name}`;
                const error = fieldErrors[field.name] ?? null;
                if (field.kind === 'switch') {
                  return (
                    <div key={field.name} className="flex items-start justify-between gap-4 rounded-lg border px-3 py-3 lg:col-span-2">
                      <div className="flex flex-col gap-1">
                        <Label htmlFor={id}>{field.label}</Label>
                        {field.help ? <p className="text-xs leading-relaxed text-muted-foreground">{field.help}</p> : null}
                      </div>
                      <Switch id={id} checked={values[field.name] === true} onCheckedChange={(checked) => set(field.name, checked)} />
                    </div>
                  );
                }
                if (field.kind === 'secret') {
                  const defined = view.secrets[field.name] === true;
                  const retype = mustRetype(field.name);
                  return (
                    <Field
                      key={field.name}
                      id={id}
                      label={field.label}
                      optional={field.optional && !retype}
                      error={error}
                      hint={
                        retype ? (
                          <span className="font-medium text-warning">{RETYPE_MESSAGE}</span>
                        ) : (
                          <>
                            <span className={cn('font-medium', defined ? 'text-success' : 'text-muted-foreground')}>{defined ? 'Défini' : 'Non défini'}</span>
                            {defined ? ' — laissez vide pour ne pas le modifier. ' : '. '}
                            {field.help}
                          </>
                        )
                      }
                    >
                      <Input
                        id={id}
                        type="password"
                        value={typeof values[field.name] === 'string' ? (values[field.name] as string) : ''}
                        onChange={(event) => set(field.name, event.target.value)}
                        placeholder={retype ? 'À ressaisir' : defined ? '•••••••••••• (inchangé)' : field.placeholder}
                        required={retype}
                        autoComplete="new-password"
                        spellCheck={false}
                        aria-invalid={error !== null}
                        className="font-mono"
                      />
                    </Field>
                  );
                }
                if (field.kind === 'textarea') {
                  return (
                    <Field key={field.name} id={id} label={field.label} optional={field.optional} error={error} hint={field.help} className="lg:col-span-2">
                      <Textarea
                        id={id}
                        value={typeof values[field.name] === 'string' ? (values[field.name] as string) : ''}
                        onChange={(event) => set(field.name, event.target.value)}
                        placeholder={field.placeholder}
                        rows={4}
                        spellCheck={false}
                        aria-invalid={error !== null}
                        className="font-mono text-xs"
                      />
                    </Field>
                  );
                }
                return (
                  <Field key={field.name} id={id} label={field.label} optional={field.optional} error={error} hint={field.help} className={field.kind === 'url' ? 'lg:col-span-2' : undefined}>
                    <Input
                      id={id}
                      type={field.kind === 'url' ? 'url' : 'text'}
                      inputMode={field.kind === 'url' ? 'url' : undefined}
                      value={typeof values[field.name] === 'string' ? (values[field.name] as string) : ''}
                      onChange={(event) => set(field.name, event.target.value)}
                      placeholder={field.placeholder}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      aria-invalid={error !== null}
                    />
                  </Field>
                );
              })}
            </div>

            {extra?.({ view, extraValues, setExtra: (name, value) => setExtraValues((current) => ({ ...current, [name]: value })) })}

            <HelpDisclosure>{help}</HelpDisclosure>

            {formError ? (
              <p role="alert" className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[13px] text-danger">
                {formError}
              </p>
            ) : null}
            <TestResult result={testResult} />

            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              <Button type="submit" disabled={!dirty} loading={save.isPending}>
                Enregistrer
              </Button>
              <Button variant="outline" onClick={runTest} loading={test.isPending} disabled={!view.configured || dirty} title={dirty ? 'Enregistrez d’abord vos modifications' : undefined}>
                {test.isPending ? null : <FlaskConical aria-hidden />}
                {testLabel}
              </Button>
              <span className="ml-auto text-xs text-muted-foreground">
                {dirty ? 'Modifications non enregistrées' : view.updatedAt ? `Modifié ${formatRelative(view.updatedAt)}` : 'Jamais enregistré'}
              </span>
            </div>
            <p className="-mt-2 text-xs text-subtle">L'enregistrement et le test demandent votre code 2FA ; chaque modification est signalée aux deux administrateurs. Les secrets sont chiffrés sur le serveur et ne sont jamais renvoyés au navigateur.</p>
          </form>
          {footer}
        </>
      ) : settings.isError ? (
        <ErrorState compact error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-busy aria-label="Chargement des réglages">
          {fields.slice(0, 4).map((field) => (
            <div key={field.name} className="flex flex-col gap-2">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-9" />
            </div>
          ))}
          <Skeleton className="h-9 w-32" />
        </div>
      )}
    </SectionShell>
  );
}
