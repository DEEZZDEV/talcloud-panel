import { randomBytes } from 'node:crypto';
import { hmac } from '../../core/crypto.js';
import { db } from '../../db/index.js';

export const BACKUP_CODE_COUNT = 10;

// Base32 de Crockford : 32 symboles (5 bits chacun, pas de biais), sans I, L, O, U.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12; // 60 bits d'entropie

function randomCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let raw = '';
  for (const byte of bytes) raw += ALPHABET[byte & 31];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

/** Tolère minuscules, espaces, tirets et les confusions O/0, I/L/1. Retourne null si le format est invalide. */
export function normalizeBackupCode(input: string): string | null {
  const raw = input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (raw.length !== CODE_LENGTH) return null;
  for (const char of raw) if (!ALPHABET.includes(char)) return null;
  return raw;
}

const hashCode = (userId: number, normalized: string): string => hmac(normalized, `backup-code:${userId}`);

/** Remplace tous les codes de secours du compte. Les codes en clair ne sont retournés qu'ici, une seule fois. */
export function regenerateBackupCodes(userId: number): string[] {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, randomCode);
  db.transaction(() => {
    db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)');
    for (const code of codes) insert.run(userId, hashCode(userId, normalizeBackupCode(code) as string));
  })();
  return codes;
}

/** Identifiant du code de secours inutilisé correspondant, ou null. Ne consomme rien. */
export function findBackupCode(userId: number, input: string): number | null {
  const normalized = normalizeBackupCode(input);
  // Le HMAC est toujours calculé, que le format soit valide ou non.
  const digest = hashCode(userId, normalized ?? 'invalide');
  if (!normalized) return null;
  const row = db.prepare('SELECT id FROM backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').get(userId, digest) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Consomme le code de façon atomique : false s'il a déjà été utilisé. */
export function consumeBackupCode(userId: number, id: number): boolean {
  return db.prepare('UPDATE backup_codes SET used_at = ? WHERE id = ? AND user_id = ? AND used_at IS NULL').run(Date.now(), id, userId).changes === 1;
}

export function backupCodesStatus(userId: number): { remaining: number; total: number } {
  const row = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(used_at IS NULL), 0) AS remaining FROM backup_codes WHERE user_id = ?').get(userId) as {
    total: number;
    remaining: number;
  };
  return { remaining: row.remaining, total: row.total };
}
