import type { MailAccount } from '@shared/api-types';
import { decrypt, encrypt } from '../../core/crypto.js';
import { badRequest, notFound } from '../../core/errors.js';
import { db, transaction } from '../../db/index.js';
import { LIMITS, type AccountCreateInput, type AccountUpdateInput } from './validation.js';

/** Ligne de la table `mail_accounts`. `password_enc` ne quitte jamais ce fichier autrement que déchiffré pour une connexion. */
export interface MailAccountRow {
  id: number;
  label: string;
  address: string;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  username: string;
  password_enc: string;
  created_at: number;
}

/** Contexte (AAD) du chiffrement : lie le chiffré à CE compte — il ne peut pas être recopié sur une autre ligne. */
const passwordContext = (id: number): string => `mail_accounts:${id}:password`;

const selectAll = db.prepare('SELECT * FROM mail_accounts ORDER BY id');
const selectOne = db.prepare('SELECT * FROM mail_accounts WHERE id = ?');
const countAll = db.prepare('SELECT COUNT(*) AS n FROM mail_accounts');
const insertRow = db.prepare(
  `INSERT INTO mail_accounts (label, address, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
);
const updatePassword = db.prepare('UPDATE mail_accounts SET password_enc = ? WHERE id = ?');
const updateRow = db.prepare(
  `UPDATE mail_accounts
      SET label = ?, address = ?, imap_host = ?, imap_port = ?, imap_secure = ?, smtp_host = ?, smtp_port = ?, smtp_secure = ?, username = ?
    WHERE id = ?`,
);
const deleteRow = db.prepare('DELETE FROM mail_accounts WHERE id = ?');

export function toMailAccount(row: MailAccountRow): MailAccount {
  return {
    id: row.id,
    label: row.label,
    address: row.address,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecure: row.imap_secure === 1,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecure: row.smtp_secure === 1,
    username: row.username,
    hasPassword: row.password_enc !== '',
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function listAccounts(): MailAccountRow[] {
  return selectAll.all() as MailAccountRow[];
}

/** Compte désigné par l'identifiant de l'URL — seule source de vérité pour choisir la boîte. Lève 404 sinon. */
export function getAccount(id: number): MailAccountRow {
  const row = selectOne.get(id) as MailAccountRow | undefined;
  if (!row) throw notFound('Compte de messagerie introuvable');
  return row;
}

/** Mot de passe en clair, uniquement pour ouvrir une connexion IMAP/SMTP. Ne jamais le journaliser ni le renvoyer. */
export function accountPassword(row: MailAccountRow): string {
  if (row.password_enc === '') throw badRequest('Aucun mot de passe enregistré pour ce compte');
  return decrypt(row.password_enc, passwordContext(row.id));
}

export function createAccount(input: AccountCreateInput): MailAccountRow {
  return transaction(() => {
    const { n } = countAll.get() as { n: number };
    if (n >= LIMITS.accounts) throw badRequest(`Nombre maximal de comptes de messagerie atteint (${LIMITS.accounts})`);
    const result = insertRow.run(
      input.label,
      input.address,
      input.imapHost,
      input.imapPort,
      input.imapSecure ? 1 : 0,
      input.smtpHost,
      input.smtpPort,
      input.smtpSecure ? 1 : 0,
      input.username,
      Date.now(),
    );
    const id = Number(result.lastInsertRowid);
    // Le contexte de chiffrement dépend de l'identifiant : le mot de passe est posé une fois la ligne créée.
    updatePassword.run(encrypt(input.password, passwordContext(id)), id);
    return getAccount(id);
  });
}

export interface UpdateResult {
  row: MailAccountRow;
  passwordChanged: boolean;
}

export function updateAccount(id: number, input: AccountUpdateInput): UpdateResult {
  return transaction(() => {
    const current = getAccount(id);
    const newPassword = input.password !== undefined && input.password !== '' ? input.password : null;
    // Le mot de passe enregistré n'est jamais envoyé à un AUTRE serveur que celui pour lequel il a été saisi :
    // changer d'hôte impose de le ressaisir (sinon une session détournée pourrait l'exfiltrer vers un hôte choisi).
    // Hôte, port ET mode TLS forment la destination : changer l'un d'eux impose aussi la ressaisie.
    const destinationChanged =
      current.imap_host.toLowerCase() !== input.imapHost.toLowerCase() ||
      current.imap_port !== input.imapPort ||
      Boolean(current.imap_secure) !== input.imapSecure ||
      current.smtp_host.toLowerCase() !== input.smtpHost.toLowerCase() ||
      current.smtp_port !== input.smtpPort ||
      Boolean(current.smtp_secure) !== input.smtpSecure;
    if (destinationChanged && newPassword === null) {
      throw badRequest('Le mot de passe doit être ressaisi lorsque le serveur, le port ou le chiffrement IMAP/SMTP change', { fieldErrors: { password: ['Mot de passe requis'] } });
    }
    updateRow.run(
      input.label,
      input.address,
      input.imapHost,
      input.imapPort,
      input.imapSecure ? 1 : 0,
      input.smtpHost,
      input.smtpPort,
      input.smtpSecure ? 1 : 0,
      input.username,
      id,
    );
    if (newPassword !== null) updatePassword.run(encrypt(newPassword, passwordContext(id)), id);
    return { row: getAccount(id), passwordChanged: newPassword !== null };
  });
}

export function deleteAccount(id: number): MailAccountRow {
  return transaction(() => {
    const row = getAccount(id);
    deleteRow.run(id);
    return row;
  });
}
