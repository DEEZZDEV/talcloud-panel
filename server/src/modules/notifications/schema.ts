import type { Migration } from '../../db/migrations.js';

/**
 * Migrations propres à ce module (tables supplémentaires au schéma commun de db/migrations.ts).
 * Identifiants préfixés par le nom du module. Ce fichier ne doit PAS importer db/index.ts.
 */
export const migrations: Migration[] = [
  {
    // Un abonnement push est rattaché à l'APPAREIL (HMAC du cookie d'appareil, même forme que sessions.device_id
    // et known_devices.device_hash) qui l'a créé : il est retiré à la déconnexion de cet appareil, à l'oubli de
    // l'appareil, à la révocation de ses sessions et lors des changements de secrets. Les abonnements antérieurs
    // ne peuvent être rattachés à aucun appareil : ils sont supprimés (le navigateur devra se réabonner).
    id: 'notifications_001_push_device',
    sql: `
      DELETE FROM push_subscriptions;
      ALTER TABLE push_subscriptions ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE push_subscriptions ADD COLUMN session_id TEXT;
      CREATE INDEX push_subscriptions_user_device ON push_subscriptions(user_id, device_id);
    `,
  },
];
