import type { AdminUser } from '@shared/api-types';
import { db } from '../../db/index.js';

export interface UserRow {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  totp_secret_enc: string;
  totp_pending_enc: string | null;
  totp_pending_at: number | null;
  totp_last_step: number;
  failed_attempts: number;
  lock_count: number;
  locked_until: number | null;
  unknown_failed_attempts: number;
  unknown_lock_count: number;
  unknown_locked_until: number | null;
  unknown_last_failure_at: number | null;
  password_changed_at: number;
  created_at: number;
}

export const MAX_ADMINS = 2;

export const toAdminUser = (row: UserRow): AdminUser => ({ id: row.id, username: row.username, email: row.email });

export function findUserById(id: number): UserRow | null {
  return (db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
}

/** Recherche par nom d'utilisateur ou e-mail (insensible à la casse, colonnes COLLATE NOCASE). */
export function findUserByIdentifier(identifier: string): UserRow | null {
  const value = identifier.trim();
  if (!value) return null;
  return (db.prepare('SELECT * FROM users WHERE username = ? OR email = ? ORDER BY id LIMIT 1').get(value, value) as UserRow | undefined) ?? null;
}

export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function listUsers(): UserRow[] {
  return db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[];
}

/** « a•••@gmail.com » : indice affiché à l'étape du code mail. */
export function emailHint(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}
