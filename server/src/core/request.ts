import type { AdminUser } from '@shared/api-types';
import type { FastifyRequest } from 'fastify';
import { stepUpRequired, unauthenticated } from './errors.js';

/** Utilisateur de la requête. Lève 401 si la requête n'est pas authentifiée. */
export function currentUser(request: FastifyRequest): AdminUser {
  if (!request.auth) throw unauthenticated();
  return request.auth.user;
}

/**
 * Exige une re-confirmation TOTP récente. À utiliser quand le besoin dépend du corps de la requête
 * (ex. signal « stop » mais pas « start ») ; sinon préférer `config: { stepUp: true }` sur la route.
 */
export function assertStepUp(request: FastifyRequest): void {
  if (!request.auth) throw unauthenticated();
  if (!request.auth.stepUpUntil || request.auth.stepUpUntil <= Date.now()) throw stepUpRequired();
}
