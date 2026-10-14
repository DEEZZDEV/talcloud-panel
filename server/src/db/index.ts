import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { migrations } from './migrations.js';

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });

/**
 * Connexion SQLite unique (better-sqlite3 est synchrone).
 * Toujours utiliser des requêtes préparées avec paramètres liés : db.prepare('… WHERE id = ?').get(id).
 * Ne jamais concaténer une valeur venant d'une requête HTTP dans du SQL.
 */
export const db: Database.Database = new Database(config.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('secure_delete = ON');

function migrate(): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((row) => (row as { id: string }).id));
  const record = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, Date.now());
    })();
  }
}

migrate();

/** Exécute `fn` dans une transaction (annulée si `fn` lève une exception). */
export function transaction<T>(fn: () => T): T {
  return db.transaction(fn)();
}
