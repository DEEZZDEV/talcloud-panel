import type { LoginConfirmDeviceRequest, LoginRequest, LoginStepResponse, LoginVerifyRequest, NewContextReason } from '@shared/api-types';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, Eye, EyeOff, Globe, KeyRound, Lock, MailCheck, MapPin, MonitorSmartphone, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Logo } from '@/components/layout/sidebar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CodeInput } from '@/components/ui/input-otp';
import { Label } from '@/components/ui/label';
import { useAuth, type SignedOutReason } from '@/features/auth/auth-context';
import { useNow } from '@/hooks/use-now';
import { api, isApiError } from '@/lib/api';
import { formatCountdown } from '@/lib/format';
import { cn } from '@/lib/utils';

type Step = 'credentials' | 'second_factor' | 'device_confirmation';
const STEP_ORDER: Step[] = ['credentials', 'second_factor', 'device_confirmation'];
const RESEND_COOLDOWN_MS = 30_000;

const SIGNED_OUT_MESSAGES: Record<SignedOutReason, string | null> = {
  logout: null,
  expired: 'Votre session a expiré. Reconnectez-vous pour continuer.',
  idle: 'Vous avez été déconnecté après une période d’inactivité.',
  revoked: 'Cette session a été fermée (expiration ou fermeture depuis un autre appareil).',
};

const REASONS: Record<NewContextReason, { icon: LucideIcon; title: string; text: string }> = {
  new_device: { icon: MonitorSmartphone, title: 'Nouvel appareil', text: 'Ce navigateur ne s’est jamais connecté à votre compte.' },
  new_ip: { icon: Globe, title: 'Nouvelle adresse IP', text: 'Vous vous connectez depuis un réseau inhabituel.' },
  new_country: { icon: MapPin, title: 'Nouveau pays', text: 'Aucune connexion précédente depuis ce pays.' },
};

/** Chemin interne uniquement : jamais de redirection vers une autre origine. */
function safeRedirect(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return '/';
  // Antislash (« /\exemple.com » est lu « //exemple.com » par les navigateurs) et caractères de contrôle refusés.
  // eslint-disable-next-line no-control-regex
  if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return '/';
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/login') ? value : '/';
}

function Notice({ tone, children }: { tone: 'danger' | 'info' | 'warning'; children: ReactNode }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'rounded-lg border px-3 py-2.5 text-[13px] leading-snug',
        tone === 'danger' && 'border-danger/25 bg-danger/10 text-danger',
        tone === 'warning' && 'border-warning/25 bg-warning/10 text-warning',
        tone === 'info' && 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}

function StepHeader({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="mb-1 flex size-10 items-center justify-center rounded-full border bg-muted text-foreground">
        <Icon className="size-[18px]" aria-hidden />
      </div>
      <h1 className="text-xl font-semibold leading-tight">{title}</h1>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

export default function LoginPage() {
  const { status, pendingLogin, signedOutReason, establish, clearSignedOutReason, refresh } = useAuth();
  const location = useLocation();
  const redirectTo = safeRedirect((location.state as { from?: unknown } | null)?.from);

  const [step, setStep] = useState<Step>('credentials');
  const [emailHint, setEmailHint] = useState('');
  const [reasons, setReasons] = useState<NewContextReason[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [resending, setResending] = useState(false);

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [emailCode, setEmailCode] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [backupCode, setBackupCode] = useState('');
  const [deviceCode, setDeviceCode] = useState('');

  const ids = { identifier: useId(), password: useId(), email: useId(), totp: useId(), backup: useId(), device: useId() };
  const resumed = useRef(false);
  const now = useNow(1000, lockedUntil !== null || resendAt > Date.now());
  const lockRemaining = lockedUntil !== null ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0;
  const resendRemaining = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const locked = lockRemaining > 0;

  useEffect(() => {
    document.title = 'Connexion — TalCloud Panel';
    return () => {
      document.title = 'TalCloud Panel';
    };
  }, []);

  useEffect(() => {
    if (lockedUntil !== null && lockRemaining === 0) setLockedUntil(null);
  }, [lockedUntil, lockRemaining]);

  // Reprise d'une connexion en cours après un rechargement de la page.
  useEffect(() => {
    if (resumed.current || status !== 'unauthenticated') return;
    resumed.current = true;
    if (pendingLogin) {
      setStep(pendingLogin.step);
      setEmailHint(pendingLogin.emailHint);
      setReasons(pendingLogin.reasons ?? []);
      setInfo('Connexion en cours reprise. Saisissez les codes reçus.');
    }
  }, [status, pendingLogin]);

  const goTo = useCallback((next: Step) => {
    setStep(next);
    setError(null);
    setInfo(null);
  }, []);

  const restart = useCallback(
    (message: string | null) => {
      setStep('credentials');
      setPassword('');
      setEmailCode('');
      setTotpCode('');
      setBackupCode('');
      setDeviceCode('');
      setUseBackup(false);
      setInfo(null);
      setError(message);
    },
    [],
  );

  /** Traduit une erreur d'API en état d'écran. Les messages restent volontairement sobres. */
  const handleError = useCallback(
    (cause: unknown) => {
      if (!isApiError(cause)) {
        setError('Une erreur inattendue est survenue. Réessayez.');
        return;
      }
      if (cause.code === 'ACCOUNT_LOCKED') {
        const wait = cause.retryAfterSeconds ?? 60;
        setLockedUntil(Date.now() + wait * 1000);
        restart(null);
        return;
      }
      if (cause.restart) {
        restart(cause.message || 'Connexion expirée. Recommencez.');
        return;
      }
      switch (cause.code) {
        case 'INVALID_CREDENTIALS':
          setError(step === 'credentials' ? 'Identifiants incorrects.' : 'Code incorrect ou expiré.');
          break;
        case 'RATE_LIMITED':
          setError(cause.message || 'Trop de tentatives. Patientez un instant avant de réessayer.');
          break;
        case 'VALIDATION_ERROR':
          setError(step === 'credentials' ? 'Renseignez votre identifiant et votre mot de passe.' : 'Vérifiez le format des codes saisis.');
          break;
        case 'IP_NOT_ALLOWED':
          setError('Connexion refusée depuis cette adresse IP.');
          break;
        case 'CSRF_INVALID':
          setError('Requête refusée. Rechargez la page, puis réessayez.');
          break;
        case 'UPSTREAM_ERROR':
        case 'NETWORK_ERROR':
          setError(cause.message);
          break;
        default:
          setError('Connexion impossible pour le moment. Réessayez.');
      }
    },
    [restart, step],
  );

  const advance = useCallback(
    (response: LoginStepResponse) => {
      if (response.step === 'done') {
        if (response.session?.authenticated) establish(response.session);
        else void refresh(true);
        return;
      }
      setEmailHint(response.emailHint ?? '');
      setReasons(response.reasons ?? []);
      setResendAt(Date.now() + RESEND_COOLDOWN_MS);
      goTo(response.step);
    },
    [establish, goTo, refresh],
  );

  const submit = useCallback(
    async (request: () => Promise<LoginStepResponse>, onFailure?: () => void) => {
      if (submitting || locked) return;
      setSubmitting(true);
      setError(null);
      setInfo(null);
      clearSignedOutReason();
      try {
        advance(await request());
      } catch (cause) {
        onFailure?.();
        handleError(cause);
      } finally {
        setSubmitting(false);
      }
    },
    [advance, clearSignedOutReason, handleError, locked, submitting],
  );

  const submitCredentials = (event: FormEvent) => {
    event.preventDefault();
    if (!identifier.trim() || !password) {
      setError('Renseignez votre identifiant et votre mot de passe.');
      return;
    }
    const body: LoginRequest = { identifier: identifier.trim(), password };
    void submit(
      () => api.post<LoginStepResponse>('/api/auth/login', body),
      () => setPassword(''),
    );
  };

  const secondFactorReady = emailCode.length === 6 && (useBackup ? backupCode.trim().length >= 6 : totpCode.length === 6);

  const submitSecondFactor = (codes?: { emailCode?: string; totpCode?: string }) => {
    const email = codes?.emailCode ?? emailCode;
    const totp = codes?.totpCode ?? totpCode;
    if (email.length !== 6 || (useBackup ? backupCode.trim().length < 6 : totp.length !== 6)) return;
    const body: LoginVerifyRequest = useBackup ? { emailCode: email, backupCode: backupCode.trim() } : { emailCode: email, totpCode: totp };
    void submit(
      () => api.post<LoginStepResponse>('/api/auth/login/verify', body),
      // La réponse ne dit pas lequel des deux codes est faux : le code mail est conservé, le second facteur est à ressaisir.
      () => {
        setTotpCode('');
        setBackupCode('');
      },
    );
  };

  const submitDevice = (code = deviceCode) => {
    if (code.length !== 8) return;
    const body: LoginConfirmDeviceRequest = { code };
    void submit(
      () => api.post<LoginStepResponse>('/api/auth/login/confirm-device', body),
      () => setDeviceCode(''),
    );
  };

  const resend = async () => {
    if (resending || resendRemaining > 0) return;
    setResending(true);
    setError(null);
    try {
      const response = await api.post<LoginStepResponse>('/api/auth/login/resend-email');
      setEmailHint(response.emailHint ?? emailHint);
      if (response.reasons) setReasons(response.reasons);
      setResendAt(Date.now() + RESEND_COOLDOWN_MS);
      setEmailCode('');
      setDeviceCode('');
      setInfo('Un nouveau code vient d’être envoyé. Le précédent n’est plus valable.');
    } catch (cause) {
      handleError(cause);
    } finally {
      setResending(false);
    }
  };

  if (status === 'authenticated') return <Navigate to={redirectTo} replace />;

  const stepIndex = STEP_ORDER.indexOf(step);
  const signedOutMessage = signedOutReason ? SIGNED_OUT_MESSAGES[signedOutReason] : null;

  const resendButton = (
    <Button variant="link" className="text-[13px]" onClick={() => void resend()} disabled={resending || resendRemaining > 0 || submitting}>
      {resendRemaining > 0 ? `Renvoyer le code (${resendRemaining} s)` : 'Renvoyer le code'}
    </Button>
  );

  const backButton = (
    <Button variant="subtle" size="sm" className="-ml-2 self-start" onClick={() => restart(null)} disabled={submitting}>
      <ArrowLeft aria-hidden />
      Recommencer
    </Button>
  );

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 py-10">
      <div aria-hidden className="bg-grid pointer-events-none absolute inset-0" />
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-[-18%] h-[420px] w-[720px] max-w-[140vw] -translate-x-1/2 rounded-full bg-primary/15 blur-[120px]" />

      <main className="relative flex w-full max-w-[400px] flex-col gap-6">
        <Logo className="self-center" />

        <div className="rounded-2xl border bg-card/90 p-6 shadow-pop backdrop-blur-sm sm:p-7">
          <ol className="mb-6 flex items-center gap-1.5" aria-label={`Étape ${stepIndex + 1} sur 3`}>
            {STEP_ORDER.map((name, index) => (
              <li key={name} className={cn('h-1 flex-1 rounded-full transition-colors duration-300', index <= stepIndex ? 'bg-primary' : 'bg-muted')} aria-hidden />
            ))}
          </ol>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -14 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col gap-5"
            >
              {step === 'credentials' ? (
                <>
                  <StepHeader icon={Lock} title="Connexion">
                    Accès réservé aux administrateurs de TalCloud.
                  </StepHeader>

                  {signedOutMessage && !error && !locked ? <Notice tone="info">{signedOutMessage}</Notice> : null}
                  {locked ? (
                    <Notice tone="warning">
                      Compte temporairement verrouillé après plusieurs échecs. Nouvel essai possible dans{' '}
                      <span className="tabular font-mono font-semibold" aria-live="polite">
                        {formatCountdown(lockRemaining)}
                      </span>
                      .
                    </Notice>
                  ) : null}
                  {error ? <Notice tone="danger">{error}</Notice> : null}

                  <form className="flex flex-col gap-4" onSubmit={submitCredentials} noValidate>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={ids.identifier}>Identifiant ou e-mail</Label>
                      <Input
                        id={ids.identifier}
                        value={identifier}
                        onChange={(event) => setIdentifier(event.target.value)}
                        autoComplete="username"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        autoFocus
                        maxLength={254}
                        disabled={submitting || locked}
                        className="h-11 sm:h-10"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={ids.password}>Mot de passe</Label>
                      <div className="relative">
                        <Input
                          id={ids.password}
                          type={showPassword ? 'text' : 'password'}
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                          autoComplete="current-password"
                          maxLength={1024}
                          disabled={submitting || locked}
                          className="h-11 pr-11 sm:h-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((current) => !current)}
                          className="absolute right-0.5 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                          aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                          aria-pressed={showPassword}
                        >
                          {showPassword ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                        </button>
                      </div>
                    </div>
                    <Button type="submit" size="lg" loading={submitting} disabled={locked} className="mt-1">
                      Continuer
                    </Button>
                  </form>
                </>
              ) : null}

              {step === 'second_factor' ? (
                <>
                  <StepHeader icon={ShieldCheck} title="Vérification en deux étapes">
                    Deux codes sont nécessaires : celui envoyé par e-mail{emailHint ? <> à <span className="font-medium text-foreground">{emailHint}</span></> : null}, et celui de votre
                    application d’authentification.
                  </StepHeader>

                  {info && !error ? <Notice tone="info">{info}</Notice> : null}
                  {error ? <Notice tone="danger">{error}</Notice> : null}

                  <form
                    className="flex flex-col gap-5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitSecondFactor();
                    }}
                    noValidate
                  >
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor={ids.email} className="flex items-center gap-1.5">
                          <MailCheck className="size-3.5 text-muted-foreground" aria-hidden />
                          Code reçu par e-mail
                        </Label>
                        {resendButton}
                      </div>
                      <CodeInput
                        id={ids.email}
                        length={6}
                        value={emailCode}
                        onChange={setEmailCode}
                        onComplete={(value) => submitSecondFactor({ emailCode: value })}
                        disabled={submitting}
                        autoFocus
                        aria-label="Code à 6 chiffres reçu par e-mail"
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor={useBackup ? ids.backup : ids.totp} className="flex items-center gap-1.5">
                          <KeyRound className="size-3.5 text-muted-foreground" aria-hidden />
                          {useBackup ? 'Code de secours' : 'Code 2FA'}
                        </Label>
                        <Button
                          variant="link"
                          className="text-[13px]"
                          onClick={() => {
                            setUseBackup((current) => !current);
                            setTotpCode('');
                            setBackupCode('');
                            setError(null);
                          }}
                          disabled={submitting}
                        >
                          {useBackup ? 'Utiliser l’application' : 'Utiliser un code de secours'}
                        </Button>
                      </div>
                      {useBackup ? (
                        <>
                          <Input
                            id={ids.backup}
                            value={backupCode}
                            onChange={(event) => setBackupCode(event.target.value)}
                            autoComplete="off"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            maxLength={64}
                            placeholder="xxxx-xxxx-xxxx"
                            disabled={submitting}
                            className="h-12 font-mono text-base tracking-wider"
                          />
                          <p className="text-xs text-muted-foreground">Chaque code de secours ne fonctionne qu’une seule fois.</p>
                        </>
                      ) : (
                        <CodeInput
                          id={ids.totp}
                          length={6}
                          value={totpCode}
                          onChange={setTotpCode}
                          onComplete={(value) => submitSecondFactor({ totpCode: value })}
                          disabled={submitting}
                          aria-label="Code à 6 chiffres de l’application d’authentification"
                        />
                      )}
                    </div>

                    <Button type="submit" size="lg" loading={submitting} disabled={!secondFactorReady}>
                      Vérifier
                    </Button>
                  </form>
                  {backButton}
                </>
              ) : null}

              {step === 'device_confirmation' ? (
                <>
                  <StepHeader icon={MonitorSmartphone} title="Confirmez cette connexion">
                    Cette connexion sort de vos habitudes. Un code à 8 chiffres vient d’être envoyé{emailHint ? <> à <span className="font-medium text-foreground">{emailHint}</span></> : null}.
                  </StepHeader>

                  {reasons.length > 0 ? (
                    <ul className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3" aria-label="Raisons de la vérification supplémentaire">
                      {reasons.map((reason) => {
                        const item = REASONS[reason];
                        if (!item) return null;
                        return (
                          <li key={reason} className="flex items-start gap-2.5">
                            <item.icon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                            <span className="flex flex-col text-[13px] leading-snug">
                              <span className="font-medium">{item.title}</span>
                              <span className="text-muted-foreground">{item.text}</span>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}

                  {info && !error ? <Notice tone="info">{info}</Notice> : null}
                  {error ? <Notice tone="danger">{error}</Notice> : null}

                  <form
                    className="flex flex-col gap-5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitDevice();
                    }}
                    noValidate
                  >
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor={ids.device}>Code de confirmation</Label>
                        {resendButton}
                      </div>
                      <CodeInput
                        id={ids.device}
                        length={8}
                        value={deviceCode}
                        onChange={setDeviceCode}
                        onComplete={(value) => submitDevice(value)}
                        disabled={submitting}
                        autoFocus
                        aria-label="Code de confirmation à 8 chiffres"
                        className="justify-between"
                      />
                    </div>
                    <Button type="submit" size="lg" loading={submitting} disabled={deviceCode.length !== 8}>
                      Confirmer et se connecter
                    </Button>
                  </form>
                  {backButton}
                </>
              ) : null}
            </motion.div>
          </AnimatePresence>
        </div>

        <p className="text-balance text-center text-xs leading-relaxed text-subtle">
          Chaque tentative de connexion est journalisée et signalée aux administrateurs.
        </p>
      </main>
    </div>
  );
}
