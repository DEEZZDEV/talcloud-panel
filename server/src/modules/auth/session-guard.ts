import type { FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../../core/audit.js';
import { accountLocked, invalidCredentials, type AppError } from '../../core/errors.js';
import { removePushForDevice } from '../notifications/push.js';
import { recordAuthFailure, type FailureKind } from './lockout.js';
import { clearSessionCookie, requestSession, revokeSession } from './sessions.js';
import type { UserRow } from './users.js';

/**
 * Échec d'une vérification de secret faite DEPUIS une session ouverte (step-up, mot de passe actuel,
 * confirmation du nouveau secret 2FA). Il compte comme un échec d'authentification ; si le compte se
 * verrouille, la session qui devinait est fermée. Retourne l'erreur à lever.
 */
export function sessionAuthFailure(request: FastifyRequest, reply: FastifyReply, user: UserRow, kind: FailureKind, message: string): AppError {
  const { lockedUntil } = recordAuthFailure(request, { user, kind });
  if (lockedUntil === null) return invalidCredentials(message);

  const session = requestSession(request);
  if (session) {
    audit(request, { action: 'security.session.revoke', target: `session ${session.id}`, details: { reason: `${kind}_failures`, current: true } });
    revokeSession(user.id, session.id);
    removePushForDevice(user.id, session.device_id);
    clearSessionCookie(reply);
  }
  return accountLocked(Math.ceil((lockedUntil - Date.now()) / 1000));
}
