import type { LoginStepResponse } from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAlertThrottle } from '../src/core/alerts.js';
import { outbox } from '../src/core/mailer.js';
import { db } from '../src/db/index.js';
import { lockDurationMs } from '../src/modules/auth/lockout.js';
import { advance, alertMails, Browser, buildTestApp, createTestAdmin, freshTotp, mailedCode, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

let app: FastifyInstance;
let alice: TestAdmin;
let bob: TestAdmin;

let midwayHandlerRuns = 0;
const WRONG = 'Mauvais-Mot-De-Passe-42!';

interface LockState {
  failed_attempts: number;
  lock_count: number;
  locked_until: number | null;
  unknown_failed_attempts: number;
  unknown_lock_count: number;
  unknown_locked_until: number | null;
}
const userState = (id: number) =>
  db.prepare('SELECT failed_attempts, lock_count, locked_until, unknown_failed_attempts, unknown_lock_count, unknown_locked_until FROM users WHERE id = ?').get(id) as LockState;
const NO_FULL_LOCK = { failed_attempts: 0, lock_count: 0, locked_until: null };
const MIN = 60_000;

const wrongPassword = (browser: Browser, admin: TestAdmin) => browser.post('/api/auth/login', { identifier: admin.username, password: WRONG });
const rightPassword = (browser: Browser, admin: TestAdmin) => browser.post<LoginStepResponse>('/api/auth/login', { identifier: admin.username, password: admin.password });
/** 5 mauvais mots de passe depuis un appareil jamais vu (aucun cookie d'appareil). */
const attackFromUnknownDevice = async (admin: TestAdmin) => {
  const attacker = new Browser(app, uniqueIp());
  for (let i = 0; i < 5; i += 1) await wrongPassword(attacker, admin);
};
/** Quelqu'un qui connaît le mot de passe échoue 5 fois au second facteur : verrou complet du compte. */
const lockAccountBySecondFactor = async (admin: TestAdmin) => {
  const holder = new Browser(app, uniqueIp());
  await rightPassword(holder, admin);
  const emailCode = mailedCode(admin.email, 'Code de connexion');
  const responses = [];
  for (let i = 0; i < 5; i += 1) responses.push(await holder.post('/api/auth/login/verify', { emailCode, totpCode: '000000' }));
  return { holder, responses };
};

beforeAll(async () => {
  useFakeClock();
  app = await buildTestApp((instance) => {
    // Simulent un évènement concurrent survenu entre onRequest et le gestionnaire (pendant la lecture du corps).
    instance.post(
      '/api/test/revoked-midway',
      { preValidation: async (request) => void db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(Date.now(), request.auth?.sessionId) },
      async () => ({ data: { runs: (midwayHandlerRuns += 1) } }),
    );
    instance.post(
      '/api/test/stepup-closed-midway',
      { config: { stepUp: true }, preValidation: async (request) => void db.prepare('UPDATE sessions SET step_up_until = NULL WHERE id = ?').run(request.auth?.sessionId) },
      async () => ({ data: { runs: (midwayHandlerRuns += 1) } }),
    );
  });
  alice = await createTestAdmin('alice');
  bob = await createTestAdmin('bob');
});

beforeEach(async () => {
  // Chaque test repart de comptes déverrouillés (les deux niveaux), sans blocage d'IP ni regroupement d'alertes en cours.
  await alertMails('');
  db.prepare(
    'UPDATE users SET failed_attempts = 0, lock_count = 0, locked_until = NULL, unknown_failed_attempts = 0, unknown_lock_count = 0, unknown_locked_until = NULL, unknown_last_failure_at = NULL',
  ).run();
  db.prepare('DELETE FROM auth_ip_blocks').run();
  db.prepare('DELETE FROM auth_failures').run();
  db.prepare('DELETE FROM login_challenges').run();
  resetAlertThrottle();
  outbox.length = 0;
  advance(60 * 60_000);
});

afterAll(async () => {
  await app.close();
});

describe('verrou « appareils inconnus » (échecs de mot de passe d’appareils jamais confirmés)', () => {
  it('5 échecs → les appareils inconnus sont bloqués 15 min, sans oracle ; appareils connus et sessions non affectés', async () => {
    // Le titulaire a un appareil connu et une session ouverte.
    const owner = new Browser(app, uniqueIp());
    await owner.login(alice);
    await alertMails('');
    outbox.length = 0;

    const attacker = new Browser(app, uniqueIp());
    for (let i = 1; i <= 4; i += 1) {
      const res = await wrongPassword(attacker, alice);
      expect(res.status).toBe(401);
      expect(userState(alice.user.id)).toMatchObject({ ...NO_FULL_LOCK, unknown_failed_attempts: i, unknown_locked_until: null });
    }
    const fifth = await wrongPassword(attacker, alice);
    // Le 5ᵉ échec reste générique : rien n'indique à l'attaquant qu'un verrou vient d'être posé.
    expect(fifth.status).toBe(401);
    expect(fifth.errorCode).toBe('INVALID_CREDENTIALS');
    const lockedUntil = Date.now() + 15 * MIN;
    // Le verrou COMPLET du compte n'est pas touché par des échecs anonymes.
    expect(userState(alice.user.id)).toMatchObject({ ...NO_FULL_LOCK, unknown_lock_count: 1, unknown_locked_until: lockedUntil });

    // Pendant le verrou, depuis un appareil inconnu : bon ou mauvais mot de passe → exactement la même réponse.
    const stranger = new Browser(app, uniqueIp());
    const wrong = await wrongPassword(stranger, alice);
    const right = await rightPassword(stranger, alice);
    expect(wrong.status).toBe(401);
    expect(right.status).toBe(401);
    expect(right.body).toEqual(wrong.body);
    expect(right.body).toEqual(fifth.body);
    expect(right.raw.headers['set-cookie']).toBeUndefined();
    expect(stranger.cookies.size).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM login_challenges WHERE user_id = ?').get(alice.user.id)).toEqual({ n: 0 });
    expect(outbox.some((m) => m.subject.includes('Code de connexion'))).toBe(false);

    // Les échecs continuent d'être comptés pendant le verrou (bon mot de passe compris, sinon ce serait un oracle)…
    expect(userState(alice.user.id)).toMatchObject({ unknown_failed_attempts: 2, unknown_locked_until: lockedUntil });
    for (let i = 0; i < 3; i += 1) await wrongPassword(new Browser(app, uniqueIp()), alice);
    // … et 5 échecs de plus le prolongent (durée doublée) : l'attaquant ne gagne aucun essai en insistant.
    expect(userState(alice.user.id)).toMatchObject({ ...NO_FULL_LOCK, unknown_failed_attempts: 0, unknown_lock_count: 2, unknown_locked_until: Date.now() + 30 * MIN });

    // Le titulaire n'est pas affecté : session ouverte, step-up, puis reconnexion depuis son appareil connu.
    expect((await owner.get('/api/test/protected')).status).toBe(200);
    advance(6 * MIN);
    await owner.get('/api/test/protected');
    expect((await owner.post('/api/test/critical')).errorCode).toBe('STEP_UP_REQUIRED');
    expect((await owner.stepUp(alice)).status).toBe(200);
    expect((await owner.post('/api/auth/logout')).status).toBe(200);
    const relogin = await owner.passwordAndSecondFactor(alice);
    expect(relogin.status).toBe(200);
    expect(relogin.body.data.step).toBe('done');
    // Un mauvais mot de passe depuis l'appareil connu reste refusé normalement.
    const knownOther = new Browser(app, owner.ip);
    knownOther.cookies.set('tc_device', owner.cookies.get('tc_device')!);
    expect((await wrongPassword(knownOther, alice)).status).toBe(401);
    db.prepare('UPDATE users SET failed_attempts = 0 WHERE id = ?').run(alice.user.id);

    // La connexion du titulaire depuis un appareil connu ne rouvre PAS d'essais aux appareils inconnus.
    expect(userState(alice.user.id).unknown_locked_until).toBeGreaterThan(Date.now());
    expect((await rightPassword(new Browser(app, uniqueIp()), alice)).status).toBe(401);
    // L'autre compte n'est pas affecté.
    expect((await rightPassword(new Browser(app, uniqueIp()), bob)).status).toBe(200);

    // Journal + alertes au titulaire (dont « bon mot de passe présenté pendant le blocage »).
    expect(db.prepare("SELECT user_id, success FROM audit_log WHERE action = 'auth.unknown_devices.locked' ORDER BY id DESC LIMIT 1").get()).toEqual({ user_id: alice.user.id, success: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.account.locked' AND user_id = ?").get(alice.user.id)).toEqual({ n: 0 });
    const lockMails = await alertMails('Connexions depuis des appareils inconnus bloquées : alice');
    expect(lockMails.length).toBe(1);
    expect(lockMails[0]!.to).toEqual([alice.email, bob.email]);
    expect((await alertMails('Mot de passe correct présenté pendant un blocage : alice')).length).toBe(1);

    // À l'expiration du verrou, un appareil inconnu peut de nouveau se connecter avec le bon mot de passe.
    advance(30 * MIN + 1000);
    const after = await rightPassword(new Browser(app, uniqueIp()), alice);
    expect(after.status).toBe(200);
    expect(after.body.data.step).toBe('second_factor');
  });

  it('jamais de 423 pour un appareil inconnu, même quand le verrou complet est actif', async () => {
    await lockAccountBySecondFactor(alice);
    expect(userState(alice.user.id).locked_until).toBeGreaterThan(Date.now());
    const stranger = new Browser(app, uniqueIp());
    const wrong = await wrongPassword(stranger, alice);
    const right = await rightPassword(stranger, alice);
    expect(right.status).toBe(401);
    expect(right.body).toEqual(wrong.body);
    expect(stranger.cookies.size).toBe(0);
  });

  it('durée doublée à chaque verrou consécutif ; remise à zéro après 24 h de calme ou après confirmation d’un nouvel appareil', async () => {
    expect(lockDurationMs(1)).toBe(15 * MIN);
    expect(lockDurationMs(2)).toBe(30 * MIN);
    expect(lockDurationMs(3)).toBe(60 * MIN);
    expect(lockDurationMs(7)).toBe(16 * 60 * MIN);
    expect(lockDurationMs(8)).toBe(24 * 60 * MIN);
    expect(lockDurationMs(50)).toBe(24 * 60 * MIN);

    await attackFromUnknownDevice(alice);
    expect(userState(alice.user.id).unknown_locked_until).toBe(Date.now() + 15 * MIN);
    advance(15 * MIN + 1000);
    await attackFromUnknownDevice(alice);
    expect(userState(alice.user.id)).toMatchObject({ unknown_lock_count: 2, unknown_locked_until: Date.now() + 30 * MIN });

    // 24 h sans échec d'appareil inconnu : compteur et escalade repartent de zéro.
    advance(24 * 60 * MIN + 1000);
    await wrongPassword(new Browser(app, uniqueIp()), alice);
    expect(userState(alice.user.id)).toMatchObject({ unknown_failed_attempts: 1, unknown_lock_count: 0 });

    // Connexion complète depuis un NOUVEL appareil (confirmé par mail) : le verrou « appareils inconnus » est levé.
    await new Browser(app, uniqueIp()).login(alice);
    expect(userState(alice.user.id)).toMatchObject({ ...NO_FULL_LOCK, unknown_failed_attempts: 0, unknown_lock_count: 0, unknown_locked_until: null });
    await attackFromUnknownDevice(alice);
    expect(userState(alice.user.id).unknown_locked_until).toBe(Date.now() + 15 * MIN);
  });

  it('ne bloque pas une connexion déjà en cours (mot de passe prouvé avant l’attaque)', async () => {
    const legit = new Browser(app, uniqueIp());
    expect((await rightPassword(legit, bob)).status).toBe(200);
    const emailCode = mailedCode(bob.email, 'Code de connexion');
    await attackFromUnknownDevice(bob);
    expect(userState(bob.user.id).unknown_locked_until).toBeGreaterThan(Date.now());
    const res = await legit.post<LoginStepResponse>('/api/auth/login/verify', { emailCode, totpCode: freshTotp(bob.totpSecret) });
    expect(res.status).toBe(200);
  });
});

describe('verrou complet du compte (échecs après preuve du mot de passe, depuis un appareil connu ou une session)', () => {
  it('5 seconds facteurs faux → compte verrouillé 15 min : 423 pour le titulaire, challenge détruit, step-up refusé', async () => {
    const owner = new Browser(app, uniqueIp());
    await owner.login(bob);

    const { holder, responses } = await lockAccountBySecondFactor(bob);
    expect(responses.slice(0, 4).map((r) => r.status)).toEqual([401, 401, 401, 401]);
    // Le détenteur du challenge a prouvé le mot de passe : lui annoncer le verrouillage n'est pas un oracle.
    expect(responses[4]!.status).toBe(423);
    expect(responses[4]!.errorCode).toBe('ACCOUNT_LOCKED');
    const state = userState(bob.user.id);
    expect(state).toMatchObject({ failed_attempts: 0, lock_count: 1, locked_until: Date.now() + 15 * MIN });
    expect(holder.cookies.has('tc_login')).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM login_challenges WHERE user_id = ?').get(bob.user.id)).toEqual({ n: 0 });

    // Appareil connu + bon mot de passe → 423 avec le délai ; mauvais mot de passe → 401 générique.
    const known = new Browser(app, owner.ip);
    known.cookies.set('tc_device', owner.cookies.get('tc_device')!);
    const right = await rightPassword(known, bob);
    expect(right.status).toBe(423);
    expect(right.errorCode).toBe('ACCOUNT_LOCKED');
    expect(right.body.error?.details).toEqual({ retryAfterSeconds: 900 });
    expect(known.cookies.has('tc_login')).toBe(false);
    expect((await wrongPassword(known, bob)).status).toBe(401);
    // Un échec pendant le verrou complet ne le prolonge pas.
    expect(userState(bob.user.id)).toMatchObject({ lock_count: 1, locked_until: state.locked_until });

    // La session ouverte reste utilisable, mais plus aucune vérification de secret n'est acceptée.
    expect((await owner.get('/api/test/protected')).status).toBe(200);
    const stepUp = await owner.post('/api/auth/step-up', { totpCode: freshTotp(bob.totpSecret) });
    expect(stepUp.status).toBe(423);

    expect(db.prepare("SELECT user_id, success FROM audit_log WHERE action = 'auth.account.locked' ORDER BY id DESC LIMIT 1").get()).toEqual({ user_id: bob.user.id, success: 0 });
    const mails = await alertMails('Compte bob verrouillé');
    expect(mails.length).toBe(1);
    expect(mails[0]!.to).toEqual([alice.email, bob.email]);

    // Après 15 minutes : la connexion est de nouveau possible.
    advance(15 * MIN + 1000);
    const after = await rightPassword(known, bob);
    expect(after.status).toBe(200);
    expect(after.body.data.step).toBe('second_factor');
  });

  it('la durée double à chaque verrouillage consécutif et repart de zéro après une connexion réussie', async () => {
    await lockAccountBySecondFactor(alice);
    expect(userState(alice.user.id).locked_until).toBe(Date.now() + 15 * MIN);
    advance(15 * MIN + 1000);
    await lockAccountBySecondFactor(alice);
    expect(userState(alice.user.id)).toMatchObject({ lock_count: 2, locked_until: Date.now() + 30 * MIN });
    advance(30 * MIN + 1000);

    await new Browser(app, uniqueIp()).login(alice);
    expect(userState(alice.user.id)).toMatchObject(NO_FULL_LOCK);
    await lockAccountBySecondFactor(alice);
    expect(userState(alice.user.id).locked_until).toBe(Date.now() + 15 * MIN);
  });

  it('les mauvais mots de passe venant d’un appareil CONNU comptent avec les échecs de second facteur', async () => {
    const owner = new Browser(app, uniqueIp());
    await owner.login(bob);
    await owner.post('/api/auth/logout');
    // 3 mauvais mots de passe depuis l'appareil connu…
    for (let i = 1; i <= 3; i += 1) {
      expect((await wrongPassword(owner, bob)).status).toBe(401);
      expect(userState(bob.user.id)).toMatchObject({ failed_attempts: i, unknown_failed_attempts: 0 });
    }
    // … puis le bon, puis 2 seconds facteurs faux = 5 échecs consécutifs.
    expect((await rightPassword(owner, bob)).status).toBe(200);
    const emailCode = mailedCode(bob.email, 'Code de connexion');
    expect((await owner.post('/api/auth/login/verify', { emailCode, totpCode: '000000' })).status).toBe(401);
    const fifth = await owner.post('/api/auth/login/verify', { emailCode, totpCode: '000000' });
    expect(fifth.status).toBe(423);
    expect(userState(bob.user.id).lock_count).toBe(1);
    expect(owner.cookies.has('tc_login')).toBe(false);

    // Même avec les bons codes, plus rien n'est possible pendant le verrouillage.
    const late = await owner.post('/api/auth/login/verify', { emailCode, totpCode: freshTotp(bob.totpSecret) });
    expect(late.status).toBe(401);
    expect(owner.cookies.has('tc_session')).toBe(false);
  });

  it('un challenge ouvert avant le verrou complet ne permet pas de le contourner', async () => {
    const legit = new Browser(app, uniqueIp());
    await rightPassword(legit, bob);
    const emailCode = mailedCode(bob.email, 'Code de connexion');
    await lockAccountBySecondFactor(bob);
    const res = await legit.post('/api/auth/login/verify', { emailCode, totpCode: freshTotp(bob.totpSecret) });
    expect(res.status).toBe(423);
    expect(legit.cookies.has('tc_session')).toBe(false);
  });

  it('step-up : 5 codes faux verrouillent le compte et ferment la session', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.login(alice);
    for (let i = 0; i < 4; i += 1) {
      const res = await browser.post('/api/auth/step-up', { totpCode: '000000' });
      expect(res.status).toBe(401);
      expect(res.errorCode).toBe('INVALID_CREDENTIALS');
      advance(7000);
    }
    const fifth = await browser.post('/api/auth/step-up', { totpCode: '000000' });
    expect(fifth.status).toBe(423);
    expect(userState(alice.user.id).lock_count).toBe(1);
    expect((await browser.get('/api/test/protected')).status).toBe(401);
    const failures = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.step_up.failure' AND user_id = ?").get(alice.user.id) as { n: number };
    expect(failures.n).toBeGreaterThanOrEqual(5);
  });
});

describe('requêtes en rafale : le verrouillage ne peut pas être dépassé par des tentatives parallèles', () => {
  it('connexion, appareils inconnus : 7 mauvais mots de passe puis le bon, envoyés en même temps → le bon est refusé', async () => {
    // 8 tentatives : le plafond de la file d'attente par identifiant (au-delà, refus immédiat en 429).
    const guesses = Array.from({ length: 7 }, () => wrongPassword(new Browser(app, uniqueIp()), alice));
    const lucky = new Browser(app, uniqueIp());
    const responses = await Promise.all([...guesses, rightPassword(lucky, alice)]);
    expect(responses.map((r) => r.status)).toEqual(Array.from({ length: 8 }, () => 401));
    expect(lucky.cookies.size).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM login_challenges WHERE user_id = ?').get(alice.user.id)).toEqual({ n: 0 });
    // Tous les essais ont été comptés un par un : 8 échecs = 1 verrou + 3 essais.
    expect(userState(alice.user.id)).toMatchObject({ ...NO_FULL_LOCK, unknown_lock_count: 1, unknown_failed_attempts: 3 });
  });

  it('connexion : au-delà de 8 tentatives en attente sur un même identifiant, les suivantes sont refusées tout de suite (429)', async () => {
    const flood = Array.from({ length: 20 }, () => wrongPassword(new Browser(app, uniqueIp()), alice));
    const statuses = (await Promise.all(flood)).map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(8);
    expect(statuses.filter((s) => s === 429)).toHaveLength(12);
  });

  it('connexion, appareil connu : après 5 échecs en rafale, le bon mot de passe encore en vol reçoit 423 et aucun challenge', async () => {
    const owner = new Browser(app, uniqueIp());
    await owner.login(bob);
    await owner.post('/api/auth/logout');
    const device = owner.cookies.get('tc_device')!;
    const fromKnownDevice = () => {
      const browser = new Browser(app, uniqueIp());
      browser.cookies.set('tc_device', device);
      return browser;
    };
    const responses = await Promise.all([...Array.from({ length: 7 }, () => wrongPassword(fromKnownDevice(), bob)), rightPassword(fromKnownDevice(), bob)]);
    expect(responses.slice(0, 7).map((r) => r.status)).toEqual(Array.from({ length: 7 }, () => 401));
    expect(responses[7]!.status).toBe(423);
    expect(userState(bob.user.id)).toMatchObject({ lock_count: 1, unknown_failed_attempts: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM login_challenges WHERE user_id = ?').get(bob.user.id)).toEqual({ n: 0 });
  });

  it('step-up : après 5 codes faux en rafale, le bon code encore en vol est refusé et la session est fermée', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.login(alice);
    advance(6 * MIN);
    await browser.get('/api/test/protected');
    const good = freshTotp(alice.totpSecret);
    const responses = await Promise.all([
      ...Array.from({ length: 7 }, () => browser.post('/api/auth/step-up', { totpCode: '000000' })),
      browser.post('/api/auth/step-up', { totpCode: good }),
    ]);
    const statuses = responses.map((r) => r.status);
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses[4]).toBe(423);
    // Tout ce qui suit le verrouillage — codes faux comme bon code — est refusé.
    for (const status of statuses.slice(5)) expect([401, 423], statuses.join(',')).toContain(status);
    expect(userState(alice.user.id).lock_count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND step_up_until > ?').get(alice.user.id, Date.now())).toEqual({ n: 0 });
    expect((await browser.get('/api/test/protected')).status).toBe(401);
  });

  it('une session révoquée ou dont le step-up s’est refermé pendant la lecture du corps n’atteint pas le gestionnaire', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.login(alice);
    // La route de test ferme la fenêtre de step-up APRÈS le contrôle d'entrée (onRequest), avant le gestionnaire.
    const closed = await browser.post('/api/test/stepup-closed-midway');
    expect(closed.status).toBe(403);
    expect(closed.errorCode).toBe('STEP_UP_REQUIRED');
    // Idem pour une révocation de session survenue entre le contrôle d'entrée et le gestionnaire.
    const revoked = await browser.post('/api/test/revoked-midway');
    expect(revoked.status).toBe(401);
    expect(revoked.errorCode).toBe('UNAUTHENTICATED');
    expect(midwayHandlerRuns).toBe(0);
  });
});

describe('blocage par IP et limitation de débit', () => {
  it('plus de 10 échecs en 15 minutes : IP bloquée 15 minutes sur l’authentification (429) + alerte', async () => {
    const ip = uniqueIp();
    const browser = new Browser(app, ip);
    for (let i = 1; i <= 11; i += 1) {
      // Identifiants inconnus variés : aucun compte n'est verrouillé, seule l'IP accumule des échecs.
      const res = await browser.post('/api/auth/login', { identifier: `inconnu${i}`, password: WRONG });
      expect(res.status).toBe(401);
      advance(7000); // reste sous la limite de débit (10/min) pour isoler le blocage par échecs
    }
    const blocked = await browser.post('/api/auth/login', { identifier: 'alice', password: alice.password });
    expect(blocked.status).toBe(429);
    expect(blocked.errorCode).toBe('RATE_LIMITED');
    expect(Number(blocked.raw.headers['retry-after'])).toBeGreaterThan(0);
    // Toutes les étapes d'authentification sont fermées à cette IP…
    expect((await browser.post('/api/auth/login/verify', { emailCode: '123456', totpCode: '123456' })).status).toBe(429);
    // … mais pas le reste (la lecture de l'état de session reste possible).
    expect((await browser.get('/api/auth/session')).status).toBe(200);

    // Une autre IP n'est pas affectée.
    const elsewhere = await new Browser(app, uniqueIp()).post('/api/auth/login', { identifier: 'alice', password: alice.password });
    expect(elsewhere.status).toBe(200);

    expect(db.prepare("SELECT target, user_id FROM audit_log WHERE action = 'auth.ip.blocked'").all()).toEqual([{ target: ip, user_id: null }]);
    const mails = await alertMails('Activité suspecte');
    expect(mails.length).toBe(1);
    expect(mails[0]!.text).toContain(ip);

    advance(15 * 60_000 + 1000);
    const after = await browser.post('/api/auth/login', { identifier: 'alice', password: alice.password });
    expect(after.status).toBe(200);
  });

  it('10 échecs ne suffisent pas à bloquer l’IP', async () => {
    const browser = new Browser(app, uniqueIp());
    for (let i = 1; i <= 10; i += 1) {
      await browser.post('/api/auth/login', { identifier: `inconnu${i}`, password: WRONG });
      advance(7000);
    }
    const res = await browser.post('/api/auth/login', { identifier: 'alice', password: alice.password });
    expect(res.status).toBe(200);
  });

  it('IPv6 : les échecs sont comptés par préfixe /64', async () => {
    for (let i = 1; i <= 11; i += 1) {
      const res = await new Browser(app, `2001:db8:abcd:12::${i.toString(16)}`).post('/api/auth/login', { identifier: `inconnu${i}`, password: WRONG });
      expect(res.status).toBe(401);
      advance(7000);
    }
    const sameSubnet = await new Browser(app, '2001:db8:abcd:12::ffff').post('/api/auth/login', { identifier: 'alice', password: alice.password });
    expect(sameSubnet.status).toBe(429);
    const otherSubnet = await new Browser(app, '2001:db8:abcd:13::1').post('/api/auth/login', { identifier: 'alice', password: alice.password });
    expect(otherSubnet.status).toBe(200);
  });

  it('limitation de débit stricte sur /api/auth : 10 requêtes par minute et par IP', async () => {
    const browser = new Browser(app, uniqueIp());
    for (let i = 1; i <= 10; i += 1) {
      // Corps invalides : aucun échec d'authentification n'est compté, seule la limite de débit joue.
      const res = await browser.post('/api/auth/login', {});
      expect(res.status).toBe(400);
    }
    const limited = await browser.post('/api/auth/login', { identifier: 'alice', password: alice.password });
    expect(limited.status).toBe(429);
    expect(limited.errorCode).toBe('RATE_LIMITED');
    expect(Number(limited.raw.headers['retry-after'])).toBeGreaterThan(0);
    // Les routes inconnues sous /api/auth sont limitées de la même façon.
    expect((await browser.post('/api/auth/nimporte-quoi', {})).status).toBe(429);
    // La limite est propre à l'IP et se rouvre après la fenêtre.
    expect((await new Browser(app, uniqueIp()).post('/api/auth/login', {})).status).toBe(400);
    advance(61_000);
    expect((await browser.post('/api/auth/login', {})).status).toBe(400);
  });

  it('limitation de débit globale : 300 requêtes par minute et par IP', async () => {
    const browser = new Browser(app, uniqueIp());
    for (let i = 0; i < 300; i += 1) {
      const res = await browser.get('/api/auth/session');
      if (res.status !== 200) throw new Error(`requête ${i + 1} : ${res.status}`);
    }
    const limited = await browser.get('/api/auth/session');
    expect(limited.status).toBe(429);
    expect(limited.errorCode).toBe('RATE_LIMITED');
  });
});

describe('alertes d’échec regroupées', () => {
  it('au plus une alerte d’échec par IP et par compte toutes les 10 minutes', async () => {
    const browser = new Browser(app, uniqueIp());
    for (let i = 0; i < 4; i += 1) await browser.post('/api/auth/login', { identifier: 'alice', password: WRONG });
    expect((await alertMails("Échec d'authentification sur le compte alice")).length).toBe(1);

    // Une autre IP sur le même compte déclenche sa propre alerte.
    db.prepare('UPDATE users SET failed_attempts = 0').run();
    await new Browser(app, uniqueIp()).post('/api/auth/login', { identifier: 'alice', password: WRONG });
    expect((await alertMails("Échec d'authentification sur le compte alice")).length).toBe(2);

    // Après 10 minutes, la même IP peut de nouveau déclencher une alerte.
    advance(10 * 60_000 + 1000);
    db.prepare('UPDATE users SET failed_attempts = 0').run();
    await browser.post('/api/auth/login', { identifier: 'alice', password: WRONG });
    expect((await alertMails("Échec d'authentification sur le compte alice")).length).toBe(3);
  });

  it('plafond global : une rafale depuis de nombreuses IP ne sature pas les boîtes mail', async () => {
    for (let i = 0; i < 25; i += 1) {
      await new Browser(app, uniqueIp()).post('/api/auth/login', { identifier: `inconnu${i}`, password: WRONG });
    }
    // Identifiants inconnus : une seule alerte, toutes IP confondues.
    expect((await alertMails('Échec de connexion (identifiant inconnu)')).length).toBe(1);
    // Tous les échecs restent journalisés.
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_failures WHERE kind = 'password'").get()).toEqual({ n: 25 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login.failure' AND at >= ?").get(Date.now())).toEqual({ n: 25 });

    // Compte connu attaqué depuis de nombreuses IP : au plus 5 alertes d'échec par fenêtre de 10 minutes…
    for (let i = 0; i < 12; i += 1) {
      await new Browser(app, uniqueIp()).post('/api/auth/login', { identifier: 'bob', password: WRONG });
    }
    // (l'alerte « identifiant inconnu » ci-dessus occupe déjà l'une des 5 places de la fenêtre).
    expect((await alertMails("Échec d'authentification sur le compte bob")).length).toBe(4);
    expect((await alertMails('Échec')).length).toBe(5);
    // … sans étouffer l'alerte de verrouillage, qui a son propre compteur.
    expect((await alertMails('Connexions depuis des appareils inconnus bloquées : bob')).length).toBe(1);
    // L'alerte suivante indique combien d'alertes ont été regroupées.
    advance(10 * 60_000 + 1000);
    await new Browser(app, uniqueIp()).post('/api/auth/login', { identifier: 'bob', password: WRONG });
    const next = (await alertMails("Échec d'authentification sur le compte bob")).at(-1)!;
    expect(next.text).toContain("Alertes similaires regroupées : 8");
  });

  it('l’identifiant saisi (qui peut être un mot de passe tapé au mauvais endroit) n’est ni journalisé ni envoyé', async () => {
    await new Browser(app, uniqueIp()).post('/api/auth/login', { identifier: 'MonVraiMotDePasseTapeIci', password: WRONG });
    await alertMails('');
    const dump = JSON.stringify([outbox, db.prepare('SELECT * FROM audit_log').all(), db.prepare('SELECT * FROM auth_failures').all()]);
    expect(dump).not.toContain('MonVraiMotDePasseTapeIci');
  });
});
