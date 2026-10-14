import type { AdminUser, SessionState } from '@shared/api-types';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { dropLocalPushSubscription } from '@/features/notifications/push';
import { api, setCsrfToken, setStepUpGrantedHandler, setUnauthenticatedHandler, stepUpStore } from '@/lib/api';
import { queryClient } from '@/lib/query';

export type SignedOutReason = 'logout' | 'expired' | 'idle' | 'revoked';
type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

interface AuthContextValue {
  status: AuthStatus;
  session: SessionState | null;
  user: AdminUser | null;
  /** Connexion en cours (étape 2 ou 3) à reprendre après un rechargement. */
  pendingLogin: SessionState['pendingLogin'];
  signedOutReason: SignedOutReason | null;
  /** Ouvre la session reçue à la fin de la connexion. */
  establish: (session: SessionState) => void;
  /** Ferme la session (appel serveur si `callServer`). */
  signOut: (reason: SignedOutReason, callServer?: boolean) => Promise<void>;
  /** Relit l'état de session ; `touch` = requête qui prolonge la session (activité réelle). */
  refresh: (touch?: boolean) => Promise<void>;
  clearSignedOutReason: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<SessionState | null>(null);
  const [pendingLogin, setPendingLogin] = useState<SessionState['pendingLogin']>(null);
  const [signedOutReason, setSignedOutReason] = useState<SignedOutReason | null>(null);
  const statusRef = useRef<AuthStatus>('loading');
  statusRef.current = status;

  /** Vide tout l'état en mémoire : jeton CSRF, cache de données, demande de 2FA en cours. */
  const clearLocalState = useCallback((reason: SignedOutReason) => {
    // Déconnexion volontaire ou session révoquée : ce navigateur cesse de recevoir les notifications push (le serveur a
    // déjà supprimé l'abonnement). Une simple expiration d'inactivité les conserve : c'est leur raison d'être.
    // Sans attente : la déconnexion n'est jamais bloquée par le service worker.
    if (reason === 'logout' || reason === 'revoked') void dropLocalPushSubscription();
    setCsrfToken(null);
    stepUpStore.cancel();
    queryClient.cancelQueries().catch(() => undefined);
    queryClient.clear();
    setSession(null);
    setPendingLogin(null);
    setSignedOutReason(reason);
    setStatus('unauthenticated');
  }, []);

  const apply = useCallback((state: SessionState) => {
    if (state.authenticated && state.user && state.csrfToken) {
      setCsrfToken(state.csrfToken);
      setSession(state);
      setPendingLogin(null);
      setStatus('authenticated');
    } else {
      setCsrfToken(null);
      setSession(null);
      setPendingLogin(state.pendingLogin ?? null);
      setStatus('unauthenticated');
    }
  }, []);

  const refresh = useCallback(
    async (touch = false) => {
      try {
        const state = await api.get<SessionState>('/api/auth/session', { silentAuth: true, background: !touch });
        if (!state.authenticated && statusRef.current === 'authenticated') clearLocalState('expired');
        else apply(state);
      } catch {
        if (statusRef.current === 'loading') setStatus('error');
      }
    },
    [apply, clearLocalState],
  );

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      if (statusRef.current === 'authenticated') clearLocalState('expired');
    });
    setStepUpGrantedHandler((until) => setSession((current) => (current ? { ...current, stepUpUntil: until } : current)));
    return () => {
      setUnauthenticatedHandler(null);
      setStepUpGrantedHandler(null);
    };
  }, [clearLocalState]);

  const establish = useCallback(
    (state: SessionState) => {
      queryClient.clear();
      setSignedOutReason(null);
      apply(state);
    },
    [apply],
  );

  const signOut = useCallback(
    async (reason: SignedOutReason, callServer = true) => {
      if (callServer) {
        try {
          await api.post('/api/auth/logout', undefined, { silentAuth: true, noStepUp: true });
        } catch {
          /* la session est peut-être déjà fermée côté serveur : l'état local est vidé dans tous les cas */
        }
      }
      clearLocalState(reason);
    },
    [clearLocalState],
  );

  const clearSignedOutReason = useCallback(() => setSignedOutReason(null), []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, session, user: session?.user ?? null, pendingLogin, signedOutReason, establish, signOut, refresh, clearSignedOutReason }),
    [status, session, pendingLogin, signedOutReason, establish, signOut, refresh, clearSignedOutReason],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth doit être utilisé dans <AuthProvider>');
  return context;
}
