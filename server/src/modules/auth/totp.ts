import { generateSecret, generateURI, verifySync } from 'otplib';
import { decrypt, encrypt } from '../../core/crypto.js';
import { db } from '../../db/index.js';

export const TOTP_ISSUER = 'TalCloud Panel';
const PERIOD_SECONDS = 30;

/** Secret TOTP Base32 de 160 bits (SHA-1, 6 chiffres, 30 s : compatible avec toutes les applications). */
export const newTotpSecret = (): string => generateSecret({ length: 20 });

export const totpUri = (username: string, secret: string): string => generateURI({ issuer: TOTP_ISSUER, label: username, secret });

// Le contexte (AAD) lie le chiffré au compte et au champ : un secret ne peut pas être recopié vers un autre compte.
const activeContext = (userId: number) => `totp:${userId}`;
const pendingContext = (userId: number) => `totp-pending:${userId}`;

export const encryptTotpSecret = (userId: number, secret: string): string => encrypt(secret, activeContext(userId));
export const decryptTotpSecret = (userId: number, payload: string): string => decrypt(payload, activeContext(userId));
export const encryptPendingTotpSecret = (userId: number, secret: string): string => encrypt(secret, pendingContext(userId));
export const decryptPendingTotpSecret = (userId: number, payload: string): string => decrypt(payload, pendingContext(userId));

export const normalizeTotpCode = (code: string): string => code.replace(/\s+/g, '');

/**
 * Vérifie un code TOTP (fenêtre ±1 pas) et retourne le pas correspondant, ou null.
 * Un code dont le pas est ≤ `lastStep` est refusé (anti-rejeu). Ne modifie rien : voir `commitTotpStep`.
 */
export function matchTotpStep(secret: string, code: string, lastStep: number): number | null {
  const token = normalizeTotpCode(code);
  if (!/^\d{6}$/.test(token)) return null;
  try {
    const result = verifySync({ secret, token, epochTolerance: PERIOD_SECONDS, afterTimeStep: lastStep });
    if (!result.valid) return null;
    const step = (result as { timeStep?: number }).timeStep;
    return typeof step === 'number' && step > lastStep ? step : null;
  } catch {
    return null;
  }
}

/**
 * Consomme le pas TOTP de façon atomique : retourne false si ce pas (ou un pas ultérieur) a déjà été accepté.
 */
export function commitTotpStep(userId: number, step: number): boolean {
  return db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?').run(step, userId, step).changes === 1;
}
