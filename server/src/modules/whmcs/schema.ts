import type { Migration } from '../../db/migrations.js';

/**
 * Migrations propres à ce module (tables supplémentaires au schéma commun de db/migrations.ts).
 * Identifiants préfixés par le nom du module. Ce fichier ne doit PAS importer db/index.ts.
 */
export const migrations: Migration[] = [];
