import type { ApiErrorCode, IntegrationName } from '@shared/api-types';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'VALIDATION_ERROR', message, details);
export const unauthenticated = (message = 'Authentification requise') => new AppError(401, 'UNAUTHENTICATED', message);
export const invalidCredentials = (message = 'Identifiants ou codes incorrects') => new AppError(401, 'INVALID_CREDENTIALS', message);
export const forbidden = (message = 'Action non autorisée') => new AppError(403, 'FORBIDDEN', message);
export const stepUpRequired = () => new AppError(403, 'STEP_UP_REQUIRED', 'Confirmation par code 2FA requise pour cette action');
export const notFound = (message = 'Ressource introuvable') => new AppError(404, 'NOT_FOUND', message);
export const accountLocked = (retryAfterSeconds: number) =>
  new AppError(423, 'ACCOUNT_LOCKED', 'Compte temporairement verrouillé après plusieurs échecs', { retryAfterSeconds });
export const rateLimited = (message = 'Trop de requêtes, réessayez plus tard') => new AppError(429, 'RATE_LIMITED', message);

export const notConfigured = (integration: IntegrationName) =>
  new AppError(409, 'INTEGRATION_NOT_CONFIGURED', `L'intégration « ${integration} » n'est pas configurée`, { integration });

/** Erreur d'une API distante. Ne jamais y mettre de secret ni de corps de réponse brut. */
export const upstream = (integration: IntegrationName, message: string, details?: Record<string, unknown>) =>
  new AppError(502, 'UPSTREAM_ERROR', message, { integration, ...details });
