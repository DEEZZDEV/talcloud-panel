/**
 * AUDIT 3 (intégrations) — D-03 : le mot de passe d'un compte mail suit un changement de PORT sans ressaisie.
 *
 * accounts.ts:updateAccount n'exige la ressaisie du mot de passe que si l'HÔTE IMAP ou SMTP change. Le port (et
 * le mode TLS) peuvent être changés librement : une session détournée (avec step-up) redirige l'IMAP/SMTP vers
 * un autre service du MÊME hôte (port ≥ 1024 accepté) et y fait envoyer le mot de passe enregistré par le test de
 * connexion. Avec un hôte en boucle locale (relais local, clair autorisé), le mot de passe part même en clair.
 * Les autres intégrations, elles, considèrent l'URL complète (port compris) comme une destination.
 *
 * Comportement sûr attendu : changer un port (ou le mode TLS) sans ressaisir le mot de passe est refusé (400).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/index.js';
import { Browser, buildTestApp, createTestAdmin, uniqueIp, useFakeClock } from './helpers.js';

let app: FastifyInstance;
let browser: Browser;

const account = {
  label: 'Relais local',
  address: 'support@exemple.test',
  imapHost: '127.0.0.1',
  imapPort: 993,
  imapSecure: true,
  smtpHost: '127.0.0.1',
  smtpPort: 465,
  smtpSecure: true,
  username: 'support-login',
  password: 'mdp-Tres-Secret-Relais-1',
};

beforeAll(async () => {
  useFakeClock();
  app = await buildTestApp();
  const admin = await createTestAdmin('dave');
  browser = new Browser(app, uniqueIp());
  await browser.login(admin); // la connexion ouvre une fenêtre de step-up
});

afterAll(async () => {
  await app.close();
});

describe('D-03 — mail : port / TLS changés sans ressaisie du mot de passe', () => {
  it('rediriger IMAP et SMTP vers un autre port (clair) du même hôte sans le mot de passe est refusé', async () => {
    const created = await browser.post<{ id: number }>('/api/mail/accounts', account);
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const { password: _omit, ...withoutPassword } = account;
    const moved = await browser.put(`/api/mail/accounts/${id}`, { ...withoutPassword, imapPort: 31337, imapSecure: false, smtpPort: 31338, smtpSecure: false });
    const row = db.prepare('SELECT imap_port, smtp_port, imap_secure, smtp_secure FROM mail_accounts WHERE id = ?').get(id);
    expect(moved.status, `destination changée sans mot de passe : ${JSON.stringify(row)}`).toBe(400);
    expect(row).toEqual({ imap_port: 993, smtp_port: 465, imap_secure: 1, smtp_secure: 1 });
  });
});
