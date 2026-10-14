import type { AdminUser } from '@shared/api-types';

/** Contexte d'authentification posé par le plugin de sécurité (modules/auth/plugin.ts). */
export interface AuthContext {
  user: AdminUser;
  sessionId: string;
  /** Fin de la fenêtre de re-confirmation TOTP (ms Unix), ou null. */
  stepUpUntil: number | null;
}

/** Informations sur l'appelant, disponibles sur toutes les requêtes (authentifiées ou non). */
export interface ClientInfo {
  ip: string;
  userAgent: string;
  /** Code pays ISO 3166-1 alpha-2, ou null si inconnu. */
  country: string | null;
  /** Identifiant d'appareil (cookie longue durée), ou null. */
  deviceId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** null tant que la requête n'est pas authentifiée (routes publiques uniquement). */
    auth: AuthContext | null;
    client: ClientInfo;
  }

  /**
   * Options de sécurité par route : `app.get('/x', { config: { stepUp: true } }, handler)`.
   * PAR DÉFAUT toute route /api exige une session valide, un jeton CSRF (hors GET/HEAD) et une IP autorisée.
   */
  interface FastifyContextConfig {
    /** Route accessible sans session (connexion, webhook, santé). À justifier au cas par cas. */
    public?: boolean;
    /** Exige une re-confirmation TOTP récente (sinon 403 STEP_UP_REQUIRED). */
    stepUp?: boolean;
    /** Désactive le contrôle CSRF : uniquement pour une route authentifiée autrement (signature HMAC du webhook). */
    skipCsrf?: boolean;
    /** N'applique pas la liste blanche d'IP : uniquement pour le webhook WHMCS (qui a son propre filtre). */
    skipIpAllowlist?: boolean;
    /** La requête ne prolonge pas la session (flux SSE, interrogations périodiques). */
    background?: boolean;
  }
}
