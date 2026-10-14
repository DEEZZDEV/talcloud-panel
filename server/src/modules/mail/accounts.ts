import { randomInt } from 'node:crypto';
import type { MailAccount, MailAccountVisibility } from '@shared/api-types';
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
  /** NULL = boîte partagée ; sinon boîte personnelle de cet administrateur. */
  owner_user_id: number | null;
}

/**
 * Compte obtenu par la règle d'accès, lié à l'administrateur qui l'a demandé (`viewerId`) : permet de revérifier le droit
 * après toute attente (file d'attente, connexion IMAP/SMTP) avec `recheckAccess`.
 */
export type BoundAccount = MailAccountRow & { readonly viewerId: number };

/** Contexte (AAD) du chiffrement : lie le chiffré à CE compte — il ne peut pas être recopié sur une autre ligne. */
const passwordContext = (id: number): string => `mail_accounts:${id}:password`;

// ───────────────────────────── Règle d'accès (unique) ─────────────────────────────
//
// Une boîte est accessible à un administrateur si elle est PARTAGÉE (owner_user_id NULL) ou s'il en est le
// PROPRIÉTAIRE. Toute lecture d'un compte passe par `getAccessibleAccount` ou `listAccessibleAccounts` : il n'existe
// aucune autre fonction exportée qui lise `mail_accounts`. Une boîte personnelle d'un autre administrateur est
// traitée EXACTEMENT comme une boîte inexistante (même requête, même 404, même message).

const ACCESS = '(owner_user_id IS NULL OR owner_user_id = ?)';
// Tri par date de création puis libellé : l'ordre ne dépend jamais de l'identifiant (aléatoire).
const selectAccessible = db.prepare(`SELECT * FROM mail_accounts WHERE ${ACCESS} ORDER BY created_at, label COLLATE NOCASE, id`);
const selectOneAccessible = db.prepare(`SELECT * FROM mail_accounts WHERE id = ? AND ${ACCESS}`);
const countAccessible = db.prepare(`SELECT COUNT(*) AS n FROM mail_accounts WHERE ${ACCESS}`);

const insertRow = db.prepare(
  `INSERT INTO mail_accounts (id, label, address, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc, created_at, owner_user_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
);
const updatePassword = db.prepare('UPDATE mail_accounts SET password_enc = ? WHERE id = ?');
const updateRow = db.prepare(
  `UPDATE mail_accounts
      SET label = ?, address = ?, imap_host = ?, imap_port = ?, imap_secure = ?, smtp_host = ?, smtp_port = ?, smtp_secure = ?, username = ?, owner_user_id = ?
    WHERE id = ?`,
);
const deleteRow = db.prepare('DELETE FROM mail_accounts WHERE id = ?');
const idExists = db.prepare('SELECT 1 FROM mail_accounts WHERE id = ?');

/**
 * Identifiant OPAQUE d'un nouveau compte : entier aléatoire (CSPRNG) dans [1, 2^31 − 1]. Un identifiant séquentiel
 * laisserait deviner, par un « trou », qu'une boîte invisible a été créée. Compatible avec le format des routes
 * (^[1-9]\d{0,9}$) et avec le contexte de chiffrement du mot de passe. Les comptes existants gardent leur identifiant.
 */
function newAccountId(): number {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomInt(1, 2_147_483_648);
    if (!idExists.get(id)) return id;
  }
  throw new Error('identifiant de compte introuvable');
}

const notFoundAccount = () => notFound('Compte de messagerie introuvable');

export const visibilityOf = (row: Pick<MailAccountRow, 'owner_user_id'>): MailAccountVisibility => (row.owner_user_id === null ? 'shared' : 'personal');

export function toMailAccount(row: MailAccountRow, userId: number): MailAccount {
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
    visibility: visibilityOf(row),
    ownedByMe: row.owner_user_id !== null && row.owner_user_id === userId,
  };
}

/** Boîtes visibles par cet administrateur : partagées + ses boîtes personnelles. */
export function listAccessibleAccounts(userId: number): BoundAccount[] {
  return (selectAccessible.all(userId) as MailAccountRow[]).map((row) => ({ ...row, viewerId: userId }));
}

/**
 * Compte désigné par l'identifiant de l'URL, SI cet administrateur y a droit. Seule porte d'entrée vers un compte :
 * 404 identique pour un compte inexistant et pour la boîte personnelle d'un autre administrateur.
 */
export function getAccessibleAccount(id: number, userId: number): BoundAccount {
  const row = selectOneAccessible.get(id, userId) as MailAccountRow | undefined;
  if (!row) throw notFoundAccount();
  return { ...row, viewerId: userId };
}

/**
 * Revérifie le droit de l'administrateur sur ce compte et renvoie la ligne RELUE (configuration à jour). À appeler après
 * chaque attente (place dans la file, connexion) et juste avant de répondre : si la boîte est devenue personnelle à
 * l'autre administrateur ou a été supprimée entre-temps, 404 identique à un compte inexistant.
 */
export function recheckAccess(account: BoundAccount): BoundAccount {
  return getAccessibleAccount(account.id, account.viewerId);
}

/** Mot de passe en clair, uniquement pour ouvrir une connexion IMAP/SMTP. Ne jamais le journaliser ni le renvoyer. */
export function accountPassword(row: MailAccountRow): string {
  if (row.password_enc === '') throw badRequest('Aucun mot de passe enregistré pour ce compte');
  return decrypt(row.password_enc, passwordContext(row.id));
}

export function createAccount(input: AccountCreateInput, userId: number): BoundAccount {
  return transaction(() => {
    // Plafond compté sur les boîtes visibles : le refus ne révèle rien des boîtes personnelles de l'autre.
    const { n } = countAccessible.get(userId) as { n: number };
    if (n >= LIMITS.accounts) throw badRequest(`Nombre maximal de comptes de messagerie atteint (${LIMITS.accounts})`);
    // Une boîte personnelle appartient toujours à celui qui la crée : aucun champ ne permet de désigner un autre propriétaire.
    const owner = input.visibility === 'personal' ? userId : null;
    const id = newAccountId();
    insertRow.run(
      id,
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
      owner,
    );
    // Le contexte de chiffrement dépend de l'identifiant : le mot de passe est posé une fois la ligne créée.
    updatePassword.run(encrypt(input.password, passwordContext(id)), id);
    return getAccessibleAccount(id, userId);
  });
}

export interface UpdateResult {
  before: MailAccountRow;
  row: BoundAccount;
  passwordChanged: boolean;
  /** Changement de visibilité effectué, ou null. */
  visibilityChange: { from: MailAccountVisibility; to: MailAccountVisibility } | null;
}

export function updateAccount(id: number, input: AccountUpdateInput, userId: number): UpdateResult {
  return transaction(() => {
    const current = getAccessibleAccount(id, userId);
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

    // Visibilité (absente = inchangée). `current` est accessible : soit partagée, soit personnelle à `userId`.
    //  - personnelle → partagée : seul le propriétaire (donc `userId`) peut le faire ;
    //  - partagée → personnelle : la boîte revient à celui qui fait la modification, jamais à quelqu'un d'autre.
    const from = visibilityOf(current);
    const to = input.visibility ?? from;
    let owner = current.owner_user_id;
    if (to === 'shared') owner = null;
    else if (from === 'shared') owner = userId;
    if (owner !== null && owner !== userId) throw notFoundAccount(); // défense en profondeur : inatteignable

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
      owner,
      id,
    );
    if (newPassword !== null) updatePassword.run(encrypt(newPassword, passwordContext(id)), id);
    return {
      before: current,
      row: getAccessibleAccount(id, userId),
      passwordChanged: newPassword !== null,
      visibilityChange: from === to ? null : { from, to },
    };
  });
}

export function deleteAccount(id: number, userId: number): BoundAccount {
  return transaction(() => {
    const row = getAccessibleAccount(id, userId);
    deleteRow.run(id);
    return row;
  });
}
