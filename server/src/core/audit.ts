import type { FastifyRequest } from 'fastify';
import { db } from '../db/index.js';

export interface AuditInput {
  /** Nom pointé : « <module>.<objet>.<verbe> », ex. « pterodactyl.server.stop », « settings.whmcs.update ». */
  action: string;
  /** Objet visé, lisible : « serveur #12 (Survie) », « VM 104 @ pve1 »… */
  target?: string | null;
  success?: boolean;
  /** Détails JSON. JAMAIS de secret, mot de passe, code ou clé API. */
  details?: Record<string, unknown> | null;
  /** À préciser quand la requête n'est pas (encore) authentifiée, ex. échec de connexion sur un compte connu. */
  userId?: number | null;
}

const insert = db.prepare(
  `INSERT INTO audit_log (at, user_id, action, target, success, ip, country, user_agent, device_id, session_id, details)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

/**
 * Ajoute une entrée au journal d'audit. Ne lève jamais d'exception (un échec de journalisation est loggé).
 * Toute action qui modifie un état (serveur, réglage, mail envoyé…) doit être journalisée, succès comme échec.
 */
export function audit(request: FastifyRequest | null, input: AuditInput): void {
  try {
    insert.run(
      Date.now(),
      input.userId ?? request?.auth?.user.id ?? null,
      input.action,
      input.target ?? null,
      input.success === false ? 0 : 1,
      request?.client?.ip ?? null,
      request?.client?.country ?? null,
      request?.client?.userAgent?.slice(0, 512) ?? null,
      request?.client?.deviceId ?? null,
      request?.auth?.sessionId ?? null,
      input.details ? JSON.stringify(input.details) : null,
    );
  } catch (err) {
    request?.log.error({ err, action: input.action }, 'audit: écriture impossible');
  }
}
