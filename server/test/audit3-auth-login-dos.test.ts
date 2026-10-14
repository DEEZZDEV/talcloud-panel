/**
 * AUDIT 3 (authentification) — C-01 : la file `serialized` (serialize.ts) permet à un anonyme d'empêcher le
 * titulaire de se connecter, MÊME depuis son appareil connu.
 *
 * login.ts:237 met toutes les tentatives d'un identifiant dans UNE file `login:<sha256(identifiant)>`, plafonnée à
 * 8 tâches en attente (serialize.ts:20) ; au-delà, refus immédiat 429. Rien ne distingue l'appareil connu du
 * titulaire des appareils inconnus : il suffit à un anonyme qui connaît le nom d'utilisateur (et l'e-mail) de garder
 * la file pleine en envoyant de mauvais mots de passe depuis de nombreuses adresses (IPv4 d'un botnet, ou les /64
 * d'un seul /48 IPv6) pour que chaque tentative du titulaire reçoive « Trop de tentatives simultanées ».
 * Or le modèle de verrouillage (lockout.ts:10-21) promet qu'« un anonyme qui connaît un identifiant ne peut pas
 * enfermer le titulaire dehors » et que les appareils connus ne sont pas affectés.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAlertThrottle } from '../src/core/alerts.js';
import { outbox } from '../src/core/mailer.js';
import { db } from '../src/db/index.js';
import { advance, Browser, buildTestApp, createTestAdmin, useFakeClock, type TestAdmin } from './helpers.js';

let app: FastifyInstance;
let alice: TestAdmin;

beforeAll(async () => {
  useFakeClock();
  app = await buildTestApp();
  alice = await createTestAdmin('alice');
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  advance(26 * 3600_000);
  db.exec('DELETE FROM auth_failures; DELETE FROM auth_ip_blocks; DELETE FROM login_challenges;');
  db.exec('UPDATE users SET failed_attempts = 0, lock_count = 0, locked_until = NULL, unknown_failed_attempts = 0, unknown_lock_count = 0, unknown_locked_until = NULL, unknown_last_failure_at = NULL');
  outbox.length = 0;
  resetAlertThrottle();
});

// Une adresse IPv6 par requête, chacune dans son propre /64 (un seul /48 en contient 65 536).
let prefix = 0;
const attackerIp = () => {
  prefix += 1;
  return `2001:db8:77:${prefix.toString(16)}::1`;
};

describe('C-01 — la file de connexion par identifiant est partagée entre les anonymes et l’appareil connu du titulaire', () => {
  it('pendant un flot anonyme de mauvais mots de passe, le bon mot de passe envoyé depuis l’appareil connu n’est pas refusé (429)', async () => {
    // Le titulaire s'est déjà connecté depuis ce navigateur : appareil, IP et pays connus.
    const owner = new Browser(app, '198.51.100.20');
    await owner.login(alice);
    expect((await owner.post('/api/auth/logout')).status).toBe(200);

    // L'attaquant lance 40 tentatives simultanées depuis 40 /64 différents (ni limite de débit ni blocage d'IP).
    const flood = Array.from({ length: 40 }, () =>
      new Browser(app, attackerIp()).post('/api/auth/login', { identifier: alice.username, password: 'Mauvais-Mot-De-Passe-123!' }),
    );
    // Pendant ce temps, le titulaire tente de se connecter depuis son appareil connu, avec le bon mot de passe.
    const ownerAttempt = owner.post('/api/auth/login', { identifier: alice.username, password: alice.password });

    const [ownerRes, ...floodRes] = await Promise.all([ownerAttempt, ...flood]);
    const refused = floodRes.filter((r) => r.status === 429).length;
    expect(refused, 'contrôle : la file est bien saturée par le flot anonyme').toBeGreaterThan(0);
    expect({ status: ownerRes.status, code: ownerRes.errorCode }, 'le titulaire, sur son appareil connu, est refusé à cause du flot').toEqual({
      status: 200,
      code: undefined,
    });
  });
});
