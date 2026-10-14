import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// Sous-clés dérivées : la clé maîtresse ne sert jamais directement.
const encKey = Buffer.from(hkdfSync('sha256', config.masterKey, Buffer.alloc(0), 'talcloud:enc:v1', 32));
const hmacKey = Buffer.from(hkdfSync('sha256', Buffer.from(config.sessionSecret, 'utf8'), Buffer.alloc(0), 'talcloud:hmac:v1', 32));

/**
 * Chiffre une chaîne en AES-256-GCM. Format : v1:<iv>:<tag>:<chiffré> (base64url).
 * `context` est lié au chiffré (AAD) : une valeur ne peut pas être déplacée d'un champ à un autre.
 */
export function encrypt(plain: string, context = ''): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join(':');
}

export function decrypt(payload: string, context = ''): string {
  const [version, iv, tag, data] = payload.split(':');
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Format de donnée chiffrée invalide');
  const ivBytes = Buffer.from(iv, 'base64url');
  const tagBytes = Buffer.from(tag, 'base64url');
  // Étiquette d'authenticité complète exigée (16 octets) : une étiquette tronquée réduirait la protection à 32 bits.
  if (ivBytes.length !== 12 || tagBytes.length !== 16) throw new Error('Format de donnée chiffrée invalide');
  const decipher = createDecipheriv('aes-256-gcm', encKey, ivBytes, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export const encryptJson = (value: unknown, context = ''): string => encrypt(JSON.stringify(value), context);
export const decryptJson = <T>(payload: string, context = ''): T => JSON.parse(decrypt(payload, context)) as T;

/** HMAC-SHA256 (hex) avec la clé serveur : pour stocker jetons de session et codes à usage unique. */
export function hmac(value: string, purpose = ''): string {
  return createHmac('sha256', hmacKey).update(`${purpose}\0${value}`).digest('hex');
}

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Jeton aléatoire opaque (base64url). 32 octets = 256 bits d'entropie. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Code numérique aléatoire sans biais de modulo. */
export function randomDigits(length = 6): string {
  let out = '';
  while (out.length < length) {
    const byte = randomBytes(1)[0]!;
    if (byte < 250) out += String(byte % 10);
  }
  return out;
}

/** Comparaison à temps constant de deux chaînes. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
