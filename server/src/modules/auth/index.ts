import type { FastifyInstance } from 'fastify';
import loginRoutes from './login.js';
import securityRoutes from './security.js';

/**
 * Routes /api/auth/* (connexion en plusieurs étapes, session, step-up) et /api/security/* (sessions, journal,
 * appareils, liste blanche, mot de passe, 2FA). Aucune route ne crée, supprime ni ne liste de compte : la CLI seule le fait.
 */
export default async function authRoutes(app: FastifyInstance): Promise<void> {
  await app.register(loginRoutes);
  await app.register(securityRoutes);
}
