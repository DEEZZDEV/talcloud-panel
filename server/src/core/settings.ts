import { db } from '../db/index.js';
import { decryptJson, encryptJson } from './crypto.js';

interface Row {
  data_enc: string;
  updated_at: number;
}

const context = (namespace: string) => `settings:${namespace}`;

/** Lit les réglages déchiffrés d'un espace de noms. Réservé au serveur : ne jamais renvoyer tel quel au client. */
export function getSettings<T extends object>(namespace: string): T | null {
  const row = db.prepare('SELECT data_enc, updated_at FROM integration_settings WHERE namespace = ?').get(namespace) as Row | undefined;
  return row ? decryptJson<T>(row.data_enc, context(namespace)) : null;
}

export function getSettingsUpdatedAt(namespace: string): number | null {
  const row = db.prepare('SELECT updated_at FROM integration_settings WHERE namespace = ?').get(namespace) as { updated_at: number } | undefined;
  return row?.updated_at ?? null;
}

export function setSettings<T extends object>(namespace: string, value: T, userId: number | null = null): void {
  db.prepare(
    `INSERT INTO integration_settings (namespace, data_enc, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(namespace) DO UPDATE SET data_enc = excluded.data_enc, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(namespace, encryptJson(value, context(namespace)), Date.now(), userId);
}
