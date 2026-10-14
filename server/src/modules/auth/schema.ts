import type { Migration } from '../../db/migrations.js';

/**
 * Migrations propres à ce module (tables supplémentaires au schéma commun de db/migrations.ts).
 * Identifiants préfixés par le nom du module. Ce fichier ne doit PAS importer db/index.ts.
 */
export const migrations: Migration[] = [
  {
    id: 'auth_001_ip_blocks',
    sql: `
      -- Blocage temporaire d'une IP sur les routes d'authentification après trop d'échecs.
      CREATE TABLE auth_ip_blocks (
        ip            TEXT PRIMARY KEY,
        blocked_until INTEGER NOT NULL,
        created_at    INTEGER NOT NULL
      );
    `,
  },
  {
    id: 'auth_002_pending_details',
    sql: `
      -- Date de mise en attente d'un nouveau secret TOTP (un secret jamais confirmé expire).
      ALTER TABLE users ADD COLUMN totp_pending_at INTEGER;
      -- Second facteur présenté à l'étape 2 ('totp' ou 'backup_code'), pour le journal et l'alerte de connexion.
      ALTER TABLE login_challenges ADD COLUMN second_factor_method TEXT;
    `,
  },
  {
    id: 'auth_003_unknown_device_lock',
    sql: `
      -- Verrou « appareils inconnus » : déclenché par les échecs de mot de passe venant d'appareils que le compte
      -- n'a jamais confirmés. Il ne touche ni les appareils connus ni les sessions ouvertes (un anonyme ne peut
      -- donc pas enfermer le titulaire dehors), contrairement au verrou complet (failed_attempts / locked_until).
      ALTER TABLE users ADD COLUMN unknown_failed_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN unknown_lock_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN unknown_locked_until INTEGER;
      ALTER TABLE users ADD COLUMN unknown_last_failure_at INTEGER;
    `,
  },
];
