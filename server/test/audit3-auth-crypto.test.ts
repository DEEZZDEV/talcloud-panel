/**
 * AUDIT 3 (authentification) — C-04 : `decrypt` (core/crypto.ts:21-28) accepte une étiquette GCM tronquée.
 *
 * `createDecipheriv('aes-256-gcm', …)` est appelé sans `authTagLength` et la longueur de l'étiquette lue dans la
 * valeur stockée n'est pas vérifiée : Node accepte alors toute étiquette de 4 à 16 octets (comportement déprécié,
 * DEP0182). Une valeur dont l'étiquette ne fait que 4 octets est déchiffrée sans erreur : l'authenticité des secrets
 * chiffrés (TOTP, clés d'API, mots de passe IMAP/SMTP, clés VAPID) ne repose plus que sur 32 bits face à quelqu'un qui
 * peut écrire dans la base (sauvegarde restaurée, accès au volume) et observer si le déchiffrement échoue.
 */
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/core/crypto.js';

describe('C-04 — longueur de l’étiquette d’authentification AES-GCM non imposée', () => {
  it('une valeur chiffrée dont l’étiquette est tronquée à 4 octets est refusée', () => {
    const stored = encrypt('JBSWY3DPEHPK3PXP', 'totp:1');
    const [version, iv, tag, data] = stored.split(':');
    const truncated = [version, iv, Buffer.from(tag!, 'base64url').subarray(0, 4).toString('base64url'), data].join(':');
    expect(() => decrypt(truncated, 'totp:1')).toThrow();
  });

  it('vérifié — le contexte (AAD) lie bien la valeur à son champ et à son compte', () => {
    const stored = encrypt('JBSWY3DPEHPK3PXP', 'totp:1');
    expect(decrypt(stored, 'totp:1')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decrypt(stored, 'totp:2')).toThrow();
    expect(() => decrypt(stored, 'totp-pending:1')).toThrow();
  });
});
