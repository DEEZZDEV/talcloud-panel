import { ShieldCheck } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CodeInput } from '@/components/ui/input-otp';
import { isApiError, stepUpStore } from '@/lib/api';
import { formatCountdown } from '@/lib/format';

/**
 * Boîte de dialogue globale de re-confirmation 2FA. Elle s'ouvre toute seule dès qu'une requête reçoit
 * STEP_UP_REQUIRED ; après validation du code, le client API rejoue la requête d'origine.
 */
export function StepUpDialog() {
  const open = useSyncExternalStore(stepUpStore.subscribe, stepUpStore.isOpen, () => false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setCode('');
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const submit = async (value: string) => {
    if (submitting || value.length !== 6) return;
    setSubmitting(true);
    setError(null);
    try {
      await stepUpStore.submit(value);
    } catch (cause) {
      setCode('');
      if (isApiError(cause) && cause.code === 'INVALID_CREDENTIALS') {
        // Un code TOTP ne sert qu'une fois : inutile de retaper le même.
        setError('Code incorrect ou déjà utilisé. Attendez le code suivant dans votre application, puis réessayez.');
      } else if (isApiError(cause) && cause.code === 'ACCOUNT_LOCKED') {
        const wait = cause.retryAfterSeconds;
        stepUpStore.cancel(cause);
        toast.error(`Compte verrouillé${wait ? ` pendant ${formatCountdown(wait)}` : ''} après plusieurs codes incorrects.`);
      } else if (isApiError(cause) && cause.code === 'UNAUTHENTICATED') {
        /* le client API a déjà renvoyé vers la connexion */
      } else {
        setError(isApiError(cause) ? cause.message : 'Vérification impossible, réessayez.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? stepUpStore.cancel() : undefined)}>
      <DialogContent className="max-w-sm" onOpenAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-link">
            <ShieldCheck className="size-5" aria-hidden />
          </div>
          <DialogTitle>Confirmez avec votre code 2FA</DialogTitle>
          <DialogDescription>Cette action est sensible. Saisissez le code à 6 chiffres de votre application d'authentification pour continuer.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(code);
          }}
        >
          <div className="flex justify-center py-1">
            <CodeInput
              length={6}
              value={code}
              onChange={(value) => {
                setCode(value);
                if (error) setError(null);
              }}
              onComplete={(value) => void submit(value)}
              disabled={submitting}
              invalid={error !== null}
              autoFocus
              aria-label="Code 2FA à 6 chiffres"
              aria-describedby={error ? 'step-up-error' : undefined}
            />
          </div>
          {error ? (
            <p id="step-up-error" role="alert" className="text-center text-[13px] leading-snug text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => stepUpStore.cancel()}>
              Annuler
            </Button>
            <Button type="submit" loading={submitting} disabled={code.length !== 6}>
              Confirmer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
