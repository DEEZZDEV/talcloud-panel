import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { ApiErrorBody, ApiErrorCode } from '@shared/api-types';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { ZodError, z } from 'zod';
import { config } from './config.js';
import { AppError } from './core/errors.js';
import authRoutes from './modules/auth/index.js';
import securityPlugin from './modules/auth/plugin.js';
import mailRoutes from './modules/mail/index.js';
import notificationsRoutes from './modules/notifications/index.js';
import proxmoxRoutes from './modules/proxmox/index.js';
import pterodactylRoutes from './modules/pterodactyl/index.js';
import whmcsRoutes from './modules/whmcs/index.js';

const statusCodes: Record<number, ApiErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'VALIDATION_ERROR',
  415: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
};

const errorBody = (code: ApiErrorCode, message: string, details?: unknown): ApiErrorBody => ({
  error: details === undefined ? { code, message } : { code, message, details },
});

export async function buildApp(): Promise<FastifyInstance> {
  const options: FastifyServerOptions = {
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
    // Délais explicites : une connexion lente ou muette ne monopolise pas le serveur.
    // connectionTimeout doit dépasser le plus long traitement (téléchargement de pièce jointe : 120 s), sinon la
    // connexion est coupée alors que l'action aboutit côté serveur.
    connectionTimeout: 150_000,
    requestTimeout: 30_000,
    logger: config.isTest
      ? false
      : {
          level: config.logLevel,
          redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'],
          ...(config.isProd ? {} : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
        },
  };
  const app = Fastify(options);

  app.setErrorHandler((err: FastifyError | AppError | ZodError, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(errorBody(err.code, err.message, err.details));
    }
    if (err instanceof ZodError) {
      return reply.status(400).send(errorBody('VALIDATION_ERROR', 'Données invalides', z.flattenError(err).fieldErrors));
    }
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) {
      // Le détail reste dans les logs serveur : rien d'interne n'est renvoyé au client.
      request.log.error({ err }, 'erreur non gérée');
      return reply.status(500).send(errorBody('INTERNAL', 'Erreur interne'));
    }
    return reply.status(status).send(errorBody(statusCodes[status] ?? 'VALIDATION_ERROR', status === 429 ? 'Trop de requêtes, réessayez plus tard' : 'Requête invalide'));
  });

  // Sécurité d'abord : en-têtes, HTTPS, liste blanche d'IP, limitation de débit, session, CSRF, step-up.
  await app.register(securityPlugin);

  app.get('/api/health', { config: { public: true, skipIpAllowlist: true, background: true } }, async () => ({ data: { status: 'ok' } }));

  await app.register(authRoutes);
  await app.register(whmcsRoutes);
  await app.register(notificationsRoutes);
  await app.register(mailRoutes);
  await app.register(pterodactylRoutes);
  await app.register(proxmoxRoutes);

  // Frontend compilé (production). En développement, Vite sert l'interface et relaie /api.
  const hasWeb = existsSync(join(config.webDistDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      wildcard: false,
      setHeaders(reply, path) {
        const immutable = path.startsWith(join(config.webDistDir, 'assets'));
        reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url === '/api' || request.url.startsWith('/api/');
    if (hasWeb && !isApi && request.method === 'GET') {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).send(errorBody('NOT_FOUND', 'Ressource introuvable'));
  });

  return app;
}
