import type { Migration } from '../../db/migrations.js';

/**
 * Migrations propres à ce module (tables supplémentaires au schéma commun de db/migrations.ts).
 * Identifiants préfixés par le nom du module. Ce fichier ne doit PAS importer db/index.ts.
 */
export const migrations: Migration[] = [
  {
    // Visibilité des comptes : NULL = boîte PARTAGÉE (les deux administrateurs) ; sinon boîte PERSONNELLE réservée
    // à cet administrateur. Les comptes existants restent partagés. La boîte disparaît avec son propriétaire.
    id: 'mail_001_owner_user_id',
    sql: `
      ALTER TABLE mail_accounts ADD COLUMN owner_user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE;
      CREATE INDEX mail_accounts_owner ON mail_accounts (owner_user_id);
    `,
  },
];
