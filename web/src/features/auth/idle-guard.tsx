import { Timer } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/auth-context';
import { lastForegroundRequestAt } from '@/lib/api';
import { formatCountdown } from '@/lib/format';

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Déconnexion automatique côté client, en complément du contrôle serveur.
 *  - L'échéance est « dernière requête ayant prolongé la session + délai d'inactivité » : la même que le serveur.
 *  - Tant que l'utilisateur agit (clavier, souris, toucher), une requête légère prolonge la session de temps en temps ;
 *    les rafraîchissements automatiques, eux, ne la prolongent jamais.
 *  - Un avertissement précède la déconnexion ; l'expiration absolue de la session est aussi surveillée.
 */
export function IdleGuard() {
  const { session, signOut, refresh } = useAuth();
  const idleMs = Math.max(60, session?.idleTimeoutSeconds ?? 900) * 1000;
  const expiresAt = session?.expiresAt ? Date.parse(session.expiresAt) : Number.POSITIVE_INFINITY;
  const warnMs = Math.min(60_000, idleMs / 4);
  const keepAliveMs = Math.min(120_000, idleMs / 3);

  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [extending, setExtending] = useState(false);
  const lastActivity = useRef(Date.now());
  const touching = useRef(false);
  const signingOut = useRef(false);

  useEffect(() => {
    const onActivity = () => {
      lastActivity.current = Date.now();
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { passive: true, capture: true });
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity, { capture: true });
    };
  }, []);

  useEffect(() => {
    const tick = () => {
      if (signingOut.current) return;
      const now = Date.now();

      if (now >= expiresAt) {
        signingOut.current = true;
        void signOut('expired');
        return;
      }

      const sinceForeground = now - lastForegroundRequestAt();
      const activeRecently = now - lastActivity.current < 5_000;
      // Activité réelle + session non prolongée depuis un moment → requête de maintien.
      if (activeRecently && sinceForeground > keepAliveMs && !touching.current && document.visibilityState === 'visible') {
        touching.current = true;
        void refresh(true).finally(() => {
          touching.current = false;
        });
      }

      const left = Math.min(idleMs - sinceForeground, expiresAt - now);
      if (left <= 0) {
        signingOut.current = true;
        void signOut('idle');
        return;
      }
      setRemainingMs(left <= warnMs ? left : null);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [idleMs, expiresAt, warnMs, keepAliveMs, refresh, signOut]);

  const open = remainingMs !== null;
  const absolute = remainingMs !== null && expiresAt - Date.now() <= warnMs;

  const stay = async () => {
    setExtending(true);
    lastActivity.current = Date.now();
    await refresh(true);
    setExtending(false);
  };

  return (
    <AlertDialog open={open}>
      <AlertDialogContent onEscapeKeyDown={(event) => event.preventDefault()}>
        <AlertDialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-full border border-warning/25 bg-warning/10 text-warning">
            <Timer className="size-5" aria-hidden />
          </div>
          <AlertDialogTitle>{absolute ? 'Votre session arrive à son terme' : 'Toujours là ?'}</AlertDialogTitle>
          <AlertDialogDescription>
            {absolute
              ? 'La durée maximale de la session est presque atteinte. Vous devrez vous reconnecter dans '
              : 'Par sécurité, vous serez déconnecté pour inactivité dans '}
            <span className="tabular font-mono font-medium text-foreground" aria-live="polite">
              {formatCountdown((remainingMs ?? 0) / 1000)}
            </span>
            .
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => void signOut('logout')}>
            Se déconnecter
          </Button>
          {absolute ? null : (
            <Button onClick={() => void stay()} loading={extending} autoFocus>
              Rester connecté
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
