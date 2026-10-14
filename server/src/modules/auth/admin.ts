import { z } from 'zod';
import { db } from '../../db/index.js';
import { regenerateBackupCodes } from './backup-codes.js';
import { hashPassword, passwordProblems } from './passwords.js';
import { revokeUserSessions } from './sessions.js';
import { encryptTotpSecret } from './totp.js';
import { countUsers, findUserById, MAX_ADMINS, type UserRow } from './users.js';

/**
 * Opérations sur les comptes administrateurs. Elles ne sont appelées QUE par la CLI (accès shell au serveur)
 * et par les routes /api/security du compte connecté : aucune route HTTP ne crée, supprime ni ne liste de compte.
 */

const usernameSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/, "3 à 32 caractères : lettres, chiffres, « . », « _ » ou « - » (pas de « @ »)");
const emailSchema = z.email('Adresse e-mail invalide').max(254);

/** Message d'erreur lisible, ou null si le nom d'utilisateur est valide et libre. */
export function usernameProblem(username: string): string | null {
  const parsed = usernameSchema.safeParse(username);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "Nom d'utilisateur invalide";
  if (db.prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(parsed.data, parsed.data)) return "Ce nom d'utilisateur est déjà pris";
  return null;
}

export function emailProblem(email: string): string | null {
  const parsed = emailSchema.safeParse(email.trim());
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Adresse e-mail invalide';
  if (db.prepare('SELECT 1 FROM users WHERE email = ? OR username = ?').get(parsed.data, parsed.data)) return 'Cette adresse e-mail est déjà utilisée';
  return null;
}

export const canCreateAdmin = (): boolean => countUsers() < MAX_ADMINS;

export interface NewAdmin {
  username: string;
  email: string;
  password: string;
  /** Secret TOTP Base32 déjà confirmé par un code valide. */
  totpSecret: string;
  /** Pas TOTP du code de confirmation (il ne pourra pas être rejoué pour se connecter). */
  totpStep?: number;
}

/** Crée un compte administrateur et ses codes de secours. Lève une erreur lisible si une règle n'est pas respectée. */
export async function createAdmin(input: NewAdmin): Promise<{ user: UserRow; backupCodes: string[] }> {
  const username = input.username.trim();
  const email = input.email.trim().toLowerCase();
  if (!canCreateAdmin()) throw new Error(`Limite de ${MAX_ADMINS} comptes administrateurs atteinte`);
  const problem = usernameProblem(username) ?? emailProblem(email);
  if (problem) throw new Error(problem);
  const problems = passwordProblems(input.password, { username, email });
  if (problems.length) throw new Error(`Mot de passe refusé : ${problems.join(', ')}`);

  const passwordHash = await hashPassword(input.password);
  const now = Date.now();

  return db.transaction(() => {
    // Le déclencheur SQL users_max_two refuse de toute façon un troisième compte.
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (username, email, password_hash, totp_secret_enc, totp_last_step, password_changed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(username, email, passwordHash, '', input.totpStep ?? 0, now, now);
    const id = Number(lastInsertRowid);
    // Le chiffré est lié à l'identifiant du compte : il n'est connu qu'après l'insertion.
    db.prepare('UPDATE users SET totp_secret_enc = ? WHERE id = ?').run(encryptTotpSecret(id, input.totpSecret), id);
    const backupCodes = regenerateBackupCodes(id);
    return { user: findUserById(id) as UserRow, backupCodes };
  })();
}

/**
 * Change le mot de passe. Les règles de robustesse sont vérifiées ici ; retourne la liste des problèmes sinon.
 * `guard` (facultatif) est appelé dans la transaction d'écriture, après le calcul du hash.
 */
export async function setPassword(user: UserRow, password: string, guard?: () => void): Promise<string[]> {
  const problems = passwordProblems(password, { username: user.username, email: user.email });
  if (problems.length) return problems;
  const passwordHash = await hashPassword(password);
  db.transaction(() => {
    // Le calcul du hash est asynchrone : `guard` revalide le contexte (session, verrouillage, hash inchangé)
    // juste avant l'écriture et lève une exception pour l'annuler.
    guard?.();
    db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(passwordHash, Date.now(), user.id);
    db.prepare('DELETE FROM login_challenges WHERE user_id = ?').run(user.id);
  })();
  return [];
}

/** Remplace le secret TOTP actif (et abandonne tout secret en attente). */
export function setTotpSecret(userId: number, secret: string, step = 0): void {
  db.transaction(() => {
    db.prepare('UPDATE users SET totp_secret_enc = ?, totp_pending_enc = NULL, totp_pending_at = NULL, totp_last_step = ? WHERE id = ?').run(encryptTotpSecret(userId, secret), step, userId);
    db.prepare('DELETE FROM login_challenges WHERE user_id = ?').run(userId);
  })();
}

export function unlockAccount(userId: number): void {
  db.prepare('UPDATE users SET failed_attempts = 0, lock_count = 0, locked_until = NULL, unknown_failed_attempts = 0, unknown_lock_count = 0, unknown_locked_until = NULL, unknown_last_failure_at = NULL WHERE id = ?').run(userId);
}

export { regenerateBackupCodes, revokeUserSessions };
