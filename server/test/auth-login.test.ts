import type { LoginStepResponse, SessionState } from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outbox } from '../src/core/mailer.js';
import { db } from '../src/db/index.js';
import { advance, alertMails, Browser, buildTestApp, createTestAdmin, freshTotp, mailedCode, totpCode, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

let app: FastifyInstance;
let alice: TestAdmin;
let bob: TestAdmin;

beforeAll(async () => {
  useFakeClock();
  app = await buildTestApp();
  alice = await createTestAdmin('alice');
  bob = await createTestAdmin('bob');
});

afterAll(async () => {
  await app.close();
});

describe('parcours de connexion complet', () => {
  const ip = uniqueIp();
  let browser: Browser;

  it('mot de passe → code mail + TOTP → confirmation d’appareil → session → route protégée', async () => {
    browser = new Browser(app, ip);

    // Avant toute connexion : pas de session, pas de connexion en cours.
    const before = await browser.get<SessionState>('/api/auth/session');
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual({ authenticated: false, pendingLogin: null });
    expect((await browser.get('/api/test/protected')).status).toBe(401);

    // Étape 1 : mot de passe.
    const first = await browser.post<LoginStepResponse>('/api/auth/login', { identifier: 'alice', password: alice.password });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ step: 'second_factor', emailHint: 'a•••@exemple.test' });
    // Le mot de passe seul n'ouvre aucune session.
    expect(browser.cookies.has('tc_session')).toBe(false);
    expect(browser.cookies.has('tc_login')).toBe(true);
    expect(browser.cookies.has('tc_device')).toBe(true);
    expect((await browser.get('/api/test/protected')).status).toBe(401);

    const pending = await browser.get<SessionState>('/api/auth/session');
    expect(pending.body.data).toEqual({ authenticated: false, pendingLogin: { step: 'second_factor', emailHint: 'a•••@exemple.test' } });

    // Étape 2 : code mail lu dans la boîte d'envoi + TOTP.
    const emailCode = mailedCode(alice.email, 'Code de connexion');
    expect(emailCode).toMatch(/^\d{6}$/);
    const second = await browser.post<LoginStepResponse>('/api/auth/login/verify', { emailCode, totpCode: freshTotp(alice.totpSecret) });
    expect(second.status).toBe(200);
    // Premier appareil, première IP : confirmation exigée, toujours pas de session.
    expect(second.body.data.step).toBe('device_confirmation');
    expect(second.body.data.reasons).toEqual(['new_device', 'new_ip']);
    expect(second.body.data.session).toBeUndefined();
    expect(browser.cookies.has('tc_session')).toBe(false);
    expect((await browser.get('/api/test/protected')).status).toBe(401);

    const pending2 = await browser.get<SessionState>('/api/auth/session');
    expect(pending2.body.data.pendingLogin).toEqual({ step: 'device_confirmation', emailHint: 'a•••@exemple.test', reasons: ['new_device', 'new_ip'] });

    // Étape 3 : code à 8 chiffres du mail « nouvel appareil ».
    const deviceCode = mailedCode(alice.email, 'Confirmation de connexion');
    expect(deviceCode).toMatch(/^\d{8}$/);
    const third = await browser.post<LoginStepResponse>('/api/auth/login/confirm-device', { code: deviceCode });
    expect(third.status).toBe(200);
    expect(third.body.data.step).toBe('done');
    const session = third.body.data.session!;
    expect(session.authenticated).toBe(true);
    expect(session.user).toEqual({ id: alice.user.id, username: 'alice', email: alice.email });
    expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.idleTimeoutSeconds).toBe(900);
    browser.csrfToken = session.csrfToken!;

    // Cookie de session : HttpOnly, SameSite=Strict, Path=/ ; le challenge est effacé.
    const setCookie = third.raw.headers['set-cookie'] as string[];
    const sessionCookie = setCookie.find((c) => c.startsWith('tc_session='))!;
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Strict');
    expect(sessionCookie).toContain('Path=/');
    expect(browser.cookies.has('tc_login')).toBe(false);

    // Route protégée accessible, avec le contexte d'appelant.
    const protectedRes = await browser.get<{ user: string; client: { ip: string } }>('/api/test/protected');
    expect(protectedRes.status).toBe(200);
    expect(protectedRes.body.data.user).toBe('alice');
    expect(protectedRes.body.data.client.ip).toBe(ip);

    const state = await browser.get<SessionState>('/api/auth/session');
    expect(state.body.data.authenticated).toBe(true);
    expect(state.body.data.csrfToken).toBe(session.csrfToken);
  });

  it('seul le HMAC des jetons est en base (session, challenge, appareil)', () => {
    const sessionToken = browser.cookies.get('tc_session')!;
    const deviceToken = browser.cookies.get('tc_device')!;
    const dump = JSON.stringify([db.prepare('SELECT * FROM sessions').all(), db.prepare('SELECT * FROM known_devices').all(), db.prepare('SELECT * FROM audit_log').all()]);
    expect(dump).not.toContain(sessionToken);
    expect(dump).not.toContain(deviceToken);
    // Le secret TOTP et le mot de passe ne sont pas stockés en clair.
    const users = JSON.stringify(db.prepare('SELECT * FROM users').all());
    expect(users).not.toContain(alice.totpSecret);
    expect(users).not.toContain(alice.password);
    expect(users).toContain('$argon2id$');
    // Les codes de secours sont hachés.
    const codes = JSON.stringify(db.prepare('SELECT * FROM backup_codes').all());
    for (const code of alice.backupCodes) expect(codes).not.toContain(code.replace(/-/g, ''));
  });

  it('la connexion réussie est journalisée et notifiée aux deux administrateurs', async () => {
    const mails = await alertMails('Connexion au panel : alice');
    expect(mails.length).toBe(1);
    expect(mails[0]!.to).toEqual([alice.email, bob.email]);
    const actions = (db.prepare('SELECT action FROM audit_log WHERE user_id = ? ORDER BY id').all(alice.user.id) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.login.password_ok', 'auth.login.second_factor_ok', 'auth.login.device_confirmed', 'auth.login.success']));
    // Aucun code ni secret dans le journal.
    const details = JSON.stringify(db.prepare('SELECT details FROM audit_log').all());
    expect(details).not.toContain(mailedCode(alice.email, 'Code de connexion'));
    expect(details).not.toContain(mailedCode(alice.email, 'Confirmation de connexion'));
  });

  it('seconde connexion depuis l’appareil et l’IP connus : pas d’étape 3', async () => {
    const logout = await browser.post('/api/auth/logout');
    expect(logout.status).toBe(200);
    expect(browser.cookies.has('tc_session')).toBe(false);
    expect((await browser.get('/api/test/protected')).status).toBe(401);

    const step = await browser.passwordAndSecondFactor(alice);
    expect(step.status).toBe(200);
    expect(step.body.data.step).toBe('done');
    expect(step.body.data.session?.authenticated).toBe(true);
    browser.csrfToken = step.body.data.session!.csrfToken!;
    expect((await browser.get('/api/test/protected')).status).toBe(200);
  });

  it('appareil connu mais nouvelle IP : confirmation exigée (new_ip seulement)', async () => {
    await browser.post('/api/auth/logout');
    browser.ip = uniqueIp();
    const step = await browser.passwordAndSecondFactor(alice);
    expect(step.body.data.step).toBe('device_confirmation');
    expect(step.body.data.reasons).toEqual(['new_ip']);
    const mail = outbox.findLast((m) => m.subject.includes('Confirmation de connexion'))!;
    expect(mail.text).toContain(browser.ip);
    expect(mail.text).toContain('Chrome 129');
    await browser.post('/api/auth/login/confirm-device', { code: mailedCode(alice.email, 'Confirmation de connexion') });
    expect((await browser.get('/api/test/protected')).status).toBe(200);
  });

  it('nouvel appareil (cookie d’appareil absent) depuis une IP connue : new_device', async () => {
    const other = new Browser(app, ip);
    const step = await other.passwordAndSecondFactor(alice);
    expect(step.body.data.reasons).toEqual(['new_device']);
  });

  it('nouveau pays : new_country', async () => {
    const traveller = new Browser(app, uniqueIp());
    traveller.country = 'FR';
    await traveller.login(alice);
    await traveller.post('/api/auth/logout');
    traveller.ip = uniqueIp();
    traveller.country = 'BR';
    const step = await traveller.passwordAndSecondFactor(alice);
    expect(step.body.data.reasons).toEqual(['new_ip', 'new_country']);
  });

  it('l’appareil connu d’un compte ne vaut pas pour l’autre compte', async () => {
    const shared = new Browser(app, uniqueIp());
    await shared.login(alice);
    await shared.post('/api/auth/logout');
    const step = await shared.passwordAndSecondFactor(bob);
    expect(step.body.data.step).toBe('device_confirmation');
    expect(step.body.data.reasons).toEqual(['new_device', 'new_ip']);
  });
});

describe('identifiants faux : réponse générique', () => {
  it('utilisateur inconnu et mauvais mot de passe donnent exactement la même réponse', async () => {
    const browser = new Browser(app, uniqueIp());
    const unknown = await browser.post('/api/auth/login', { identifier: 'personne', password: 'Peu-Importe-123456!' });
    const wrong = await browser.post('/api/auth/login', { identifier: 'bob', password: 'Peu-Importe-123456!' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.errorCode).toBe('INVALID_CREDENTIALS');
    expect(unknown.body).toEqual(wrong.body);
    // Aucun cookie de connexion ni d'appareil n'est posé sur un échec.
    expect(browser.cookies.size).toBe(0);
    expect(unknown.raw.headers['set-cookie']).toBeUndefined();
    expect(wrong.raw.headers['set-cookie']).toBeUndefined();
  });

  it('la connexion par e-mail fonctionne, sans sensibilité à la casse', async () => {
    const browser = new Browser(app, uniqueIp());
    const res = await browser.post<LoginStepResponse>('/api/auth/login', { identifier: 'BOB@Exemple.Test', password: bob.password });
    expect(res.status).toBe(200);
    expect(res.body.data.step).toBe('second_factor');
  });

  it('un échec sur un compte connu est journalisé avec son userId et alerté ; jamais le mot de passe saisi', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.post('/api/auth/login', { identifier: 'bob', password: 'Mauvais-Mot-De-Passe-42!' });
    const row = db.prepare("SELECT user_id, success, ip, details FROM audit_log WHERE action = 'auth.login.failure' ORDER BY id DESC LIMIT 1").get() as {
      user_id: number;
      success: number;
      ip: string;
      details: string;
    };
    expect(row.user_id).toBe(bob.user.id);
    expect(row.success).toBe(0);
    expect(row.ip).toBe(browser.ip);
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_log').all())).not.toContain('Mauvais-Mot-De-Passe-42!');
    const mails = await alertMails("Échec d'authentification sur le compte bob");
    expect(mails.length).toBeGreaterThanOrEqual(1);
    expect(mails.at(-1)!.text).toContain(browser.ip);
  });

  it('corps invalide → 400 sans compter d’échec', async () => {
    const browser = new Browser(app, uniqueIp());
    const res = await browser.post('/api/auth/login', { identifier: 'bob' });
    expect(res.status).toBe(400);
    expect(res.errorCode).toBe('VALIDATION_ERROR');
  });
});

describe('second facteur', () => {
  it('les deux facteurs sont exigés : code mail juste + TOTP faux, ou l’inverse, échouent de façon identique', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.post('/api/auth/login', { identifier: 'bob', password: bob.password });
    const emailCode = mailedCode(bob.email, 'Code de connexion');
    const goodTotp = freshTotp(bob.totpSecret);
    const badTotp = goodTotp === '000000' ? '000001' : '000000';
    const badEmail = emailCode === '111111' ? '111112' : '111111';

    const wrongTotp = await browser.post('/api/auth/login/verify', { emailCode, totpCode: badTotp });
    const wrongEmail = await browser.post('/api/auth/login/verify', { emailCode: badEmail, totpCode: goodTotp });
    expect(wrongTotp.status).toBe(401);
    expect(wrongEmail.status).toBe(401);
    expect(wrongTotp.body).toEqual(wrongEmail.body);
    expect(wrongTotp.errorCode).toBe('INVALID_CREDENTIALS');
    expect(browser.cookies.has('tc_session')).toBe(false);

    // Sans second facteur du tout : refus de validation.
    const missing = await browser.post('/api/auth/login/verify', { emailCode });
    expect(missing.status).toBe(400);
    // Les deux à la fois : refus également.
    const both = await browser.post('/api/auth/login/verify', { emailCode, totpCode: goodTotp, backupCode: bob.backupCodes[9] });
    expect(both.status).toBe(400);

    // Le TOTP valide présenté avec un mauvais code mail n'a pas été consommé : la connexion reste possible.
    const ok = await browser.post<LoginStepResponse>('/api/auth/login/verify', { emailCode, totpCode: goodTotp });
    expect(ok.status).toBe(200);
    expect(ok.body.data.step).toBe('device_confirmation');
    db.prepare('UPDATE users SET failed_attempts = 0 WHERE id = ?').run(bob.user.id);
  });

  it('rejeu d’un code TOTP déjà accepté : refusé', async () => {
    const first = new Browser(app, uniqueIp());
    await first.post('/api/auth/login', { identifier: 'bob', password: bob.password });
    const usedTotp = freshTotp(bob.totpSecret);
    const ok = await first.post<LoginStepResponse>('/api/auth/login/verify', { emailCode: mailedCode(bob.email, 'Code de connexion'), totpCode: usedTotp });
    expect(ok.status).toBe(200);

    // Un attaquant qui a capté le mot de passe et ce code TOTP le rejoue dans la même fenêtre de 30 s.
    const attacker = new Browser(app, uniqueIp());
    await attacker.post('/api/auth/login', { identifier: 'bob', password: bob.password });
    const replay = await attacker.post('/api/auth/login/verify', { emailCode: mailedCode(bob.email, 'Code de connexion'), totpCode: usedTotp });
    expect(replay.status).toBe(401);
    expect(replay.errorCode).toBe('INVALID_CREDENTIALS');

    // Le code du pas précédent (encore dans la fenêtre ±1) est lui aussi refusé : il est antérieur au dernier pas accepté.
    const older = await attacker.post('/api/auth/login/verify', { emailCode: mailedCode(bob.email, 'Code de connexion'), totpCode: totpCode(bob.totpSecret, -1) });
    expect(older.status).toBe(401);

    // Le code suivant fonctionne.
    const next = await attacker.post<LoginStepResponse>('/api/auth/login/verify', { emailCode: mailedCode(bob.email, 'Code de connexion'), totpCode: freshTotp(bob.totpSecret) });
    expect(next.status).toBe(200);
    db.prepare('UPDATE users SET failed_attempts = 0 WHERE id = ?').run(bob.user.id);
  });

  it('fenêtre ±1 pas : le code du pas précédent est accepté, celui d’il y a 2 pas refusé', async () => {
    advance(120_000);
    const browser = new Browser(app, uniqueIp());
    await browser.post('/api/auth/login', { identifier: 'bob', password: bob.password });
    const emailCode = mailedCode(bob.email, 'Code de connexion');
    const tooOld = await browser.post('/api/auth/login/verify', { emailCode, totpCode: totpCode(bob.totpSecret, -2) });
    expect(tooOld.status).toBe(401);
    const previous = await browser.post<LoginStepResponse>('/api/auth/login/verify', { emailCode, totpCode: totpCode(bob.totpSecret, -1) });
    expect(previous.status).toBe(200);
    db.prepare('UPDATE users SET failed_attempts = 0 WHERE id = ?').run(bob.user.id);
  });

  it('code de secours : remplace le TOTP (pas le code mail) et ne sert qu’une fois', async () => {
    const backupCode = bob.backupCodes[0]!;
    const browser = new Browser(app, uniqueIp());
    await browser.post('/api/auth/login', { identifier: 'bob', password: bob.password });

    // Un code de secours ne dispense pas du code mail.
    const noEmail = await browser.post('/api/auth/login/verify', { emailCode: '000000', backupCode });
    expect(noEmail.status).toBe(401);

    // Saisie tolérante (minuscules, sans tirets).
    const ok = await browser.post<LoginStepResponse>('/api/auth/login/verify', {
      emailCode: mailedCode(bob.email, 'Code de connexion'),
      backupCode: backupCode.toLowerCase().replace(/-/g, ' '),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.step).toBe('device_confirmation');
    const used = db.prepare('SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ? AND used_at IS NOT NULL').get(bob.user.id) as { n: number };
    expect(used.n).toBe(1);

    // Réutilisation : refusée.
    const again = new Browser(app, uniqueIp());
    await again.post('/api/auth/login', { identifier: 'bob', password: bob.password });
    const reuse = await again.post('/api/auth/login/verify', { emailCode: mailedCode(bob.email, 'Code de connexion'), backupCode });
    expect(reuse.status).toBe(401);
    expect(reuse.errorCode).toBe('INVALID_CREDENTIALS');

    // Un code de secours d'un autre compte ne fonctionne pas.
    const foreign = await again.post('/api/auth/login/verify', { emailCode: mailedCode(bob.email, 'Code de connexion'), backupCode: alice.backupCodes[0]! });
    expect(foreign.status).toBe(401);
    db.prepare('UPDATE users SET failed_attempts = 0 WHERE id = ?').run(bob.user.id);
  });

  it('code mail expiré après 10 minutes ; challenge expiré : il faut recommencer', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.post('/api/auth/login', { identifier: 'bob', password: bob.password });
    const emailCode = mailedCode(bob.email, 'Code de connexion');
    advance(10 * 60_000 + 1000);
    const res = await browser.post('/api/auth/login/verify', { emailCode, totpCode: totpCode(bob.totpSecret) });
    expect(res.status).toBe(401);
    expect(res.body.error?.details).toEqual({ restart: true });
    const state = await browser.get<SessionState>('/api/auth/session');
    expect(state.body.data.pendingLogin).toBeNull();
  });

  it('sans challenge (cookie absent ou forgé) : refus', async () => {
    const browser = new Browser(app, uniqueIp());
    const none = await browser.post('/api/auth/login/verify', { emailCode: '123456', totpCode: '123456' });
    expect(none.status).toBe(401);
    browser.cookies.set('tc_login', 'A'.repeat(43));
    const forged = await browser.post('/api/auth/login/confirm-device', { code: '12345678' });
    expect(forged.status).toBe(401);
    // Un cookie de session forgé n'authentifie pas.
    browser.cookies.set('tc_session', 'B'.repeat(43));
    expect((await browser.get('/api/test/protected')).status).toBe(401);
  });

  it('5 essais par challenge, puis destruction du challenge', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.post('/api/auth/login', { identifier: 'alice', password: alice.password });
    const emailCode = mailedCode(alice.email, 'Code de connexion');
    for (let i = 0; i < 4; i += 1) {
      const res = await browser.post('/api/auth/login/verify', { emailCode, totpCode: '000000' });
      expect(res.status).toBe(401);
      // Le compteur du compte est remis à zéro pour isoler la limite propre au challenge.
      db.prepare('UPDATE users SET failed_attempts = 0 WHERE id = ?').run(alice.user.id);
    }
    const fifth = await browser.post('/api/auth/login/verify', { emailCode, totpCode: '000000' });
    expect(fifth.status).toBe(401);
    expect(fifth.body.error?.details).toEqual({ restart: true });
    db.prepare('UPDATE users SET failed_attempts = 0 WHERE id = ?').run(alice.user.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM login_challenges WHERE user_id = ?').get(alice.user.id)).toEqual({ n: 0 });
    // Même avec les bons codes, le challenge n'existe plus.
    const late = await browser.post('/api/auth/login/verify', { emailCode, totpCode: freshTotp(alice.totpSecret) });
    expect(late.status).toBe(401);
  });

  it('confirmation d’appareil : mauvais code refusé, changement d’IP annule la connexion', async () => {
    const browser = new Browser(app, uniqueIp());
    const step = await browser.passwordAndSecondFactor(alice);
    expect(step.body.data.step).toBe('device_confirmation');
    const code = mailedCode(alice.email, 'Confirmation de connexion');
    const wrong = await browser.post('/api/auth/login/confirm-device', { code: code === '00000000' ? '00000001' : '00000000' });
    expect(wrong.status).toBe(401);
    expect(browser.cookies.has('tc_session')).toBe(false);

    // Le code mail de l'étape 2 (6 chiffres) n'est pas un code de confirmation valide.
    const sixDigits = await browser.post('/api/auth/login/confirm-device', { code: mailedCode(alice.email, 'Code de connexion') });
    expect(sixDigits.status).toBe(400);

    browser.ip = uniqueIp();
    const moved = await browser.post('/api/auth/login/confirm-device', { code });
    expect(moved.status).toBe(401);
    expect(moved.body.error?.details).toEqual({ restart: true });
    expect(browser.cookies.has('tc_session')).toBe(false);
    db.prepare('UPDATE users SET failed_attempts = 0 WHERE id = ?').run(alice.user.id);
  });

  it('renvoi du code : nouveau code, l’ancien ne vaut plus, 3 envois au maximum par étape', async () => {
    const browser = new Browser(app, uniqueIp());
    await browser.post('/api/auth/login', { identifier: 'alice', password: alice.password });
    const firstCode = mailedCode(alice.email, 'Code de connexion');

    const resend1 = await browser.post<LoginStepResponse>('/api/auth/login/resend-email');
    expect(resend1.status).toBe(200);
    expect(resend1.body.data).toEqual({ step: 'second_factor', emailHint: 'a•••@exemple.test' });
    const secondCode = mailedCode(alice.email, 'Code de connexion');
    const resend2 = await browser.post('/api/auth/login/resend-email');
    expect(resend2.status).toBe(200);
    const resend3 = await browser.post('/api/auth/login/resend-email');
    expect(resend3.status).toBe(429);
    expect(resend3.errorCode).toBe('RATE_LIMITED');

    const thirdCode = mailedCode(alice.email, 'Code de connexion');
    if (firstCode !== thirdCode) {
      const stale = await browser.post('/api/auth/login/verify', { emailCode: firstCode, totpCode: freshTotp(alice.totpSecret) });
      expect(stale.status).toBe(401);
    }
    expect([firstCode, secondCode, thirdCode].every((c) => /^\d{6}$/.test(c))).toBe(true);
    const ok = await browser.post<LoginStepResponse>('/api/auth/login/verify', { emailCode: thirdCode, totpCode: freshTotp(alice.totpSecret) });
    expect(ok.status).toBe(200);
    db.prepare('UPDATE users SET failed_attempts = 0 WHERE id = ?').run(alice.user.id);
  });
});

describe('pas de fixation de session', () => {
  it('un cookie de session présenté avant la connexion n’est jamais adopté', async () => {
    const browser = new Browser(app, uniqueIp());
    const planted = 'C'.repeat(43);
    browser.cookies.set('tc_session', planted);
    await browser.login(alice);
    expect(browser.cookies.get('tc_session')).not.toBe(planted);
    expect(browser.cookies.get('tc_session')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('chaque connexion produit un jeton de session et un jeton CSRF différents', async () => {
    const a = new Browser(app, uniqueIp());
    const b = new Browser(app, uniqueIp());
    const sa = await a.login(alice);
    const sb = await b.login(alice);
    expect(a.cookies.get('tc_session')).not.toBe(b.cookies.get('tc_session'));
    expect(sa.csrfToken).not.toBe(sb.csrfToken);
  });
});

describe('mails', () => {
  it('les valeurs venant de la requête sont échappées dans le HTML', async () => {
    const browser = new Browser(app, uniqueIp(), '<script>alert(1)</script>"><img src=x onerror=alert(2)>');
    await browser.post('/api/auth/login', { identifier: 'alice', password: alice.password });
    const mail = outbox.findLast((m) => m.subject.includes('Code de connexion'))!;
    expect(mail.html).toBeDefined();
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;script&gt;');
    // Le code n'est jamais dans l'objet du mail.
    expect(mail.subject).not.toMatch(/\d{6}/);
  });
});
