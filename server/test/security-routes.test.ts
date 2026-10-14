import type { AuditEntry, BackupCodes, BackupCodesStatus, IpAllowlist, KnownDevice, LoginStepResponse, SessionInfo, TotpSetup } from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { subscribe, type BusMessage } from '../src/core/events.js';
import { outbox } from '../src/core/mailer.js';
import { getSettings } from '../src/core/settings.js';
import { db } from '../src/db/index.js';
import { setPanelAllowlist } from '../src/modules/auth/ip-allowlist.js';
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

beforeEach(() => {
  db.prepare('UPDATE users SET failed_attempts = 0, lock_count = 0, locked_until = NULL').run();
  advance(61_000);
});

afterAll(async () => {
  await app.close();
});

describe('sessions', () => {
  it('liste les sessions actives du compte connecté uniquement', async () => {
    const a1 = new Browser(app, uniqueIp());
    const a2 = new Browser(app, uniqueIp(), 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0');
    const b1 = new Browser(app, uniqueIp());
    await a1.login(alice);
    await a2.login(alice);
    await b1.login(bob);

    const res = await a1.get<SessionInfo[]>('/api/security/sessions');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
    const current = res.body.data.find((s) => s.current)!;
    const other = res.body.data.find((s) => !s.current)!;
    expect(current.ip).toBe(a1.ip);
    expect(current.deviceLabel).toBe('Chrome 129 · Windows');
    expect(other.ip).toBe(a2.ip);
    expect(other.deviceLabel).toBe('Firefox 130 · Linux');
    expect(Object.keys(current).sort()).toEqual(['country', 'createdAt', 'current', 'deviceLabel', 'expiresAt', 'id', 'ip', 'lastSeenAt', 'userAgent'].sort());
    // Aucun jeton dans la réponse.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(a1.cookies.get('tc_session')!);
    expect(raw).not.toContain(a2.cookies.get('tc_session')!);

    const bobSessions = await b1.get<SessionInfo[]>('/api/security/sessions');
    expect(bobSessions.body.data.length).toBe(1);
    expect(bobSessions.body.data[0]!.ip).toBe(b1.ip);
  });

  it('révoquer une session : elle cesse de fonctionner aussitôt et un évènement session_revoked est publié', async () => {
    const keeper = new Browser(app, uniqueIp());
    const target = new Browser(app, uniqueIp());
    await keeper.login(alice);
    await target.login(alice);
    const list = await keeper.get<SessionInfo[]>('/api/security/sessions');
    const targetId = list.body.data.find((s) => s.ip === target.ip)!.id;

    const events: BusMessage[] = [];
    const unsubscribe = subscribe((message) => events.push(message));
    const res = await keeper.delete(`/api/security/sessions/${targetId}`);
    unsubscribe();
    expect(res.status).toBe(200);
    expect(events).toEqual([{ event: { type: 'session_revoked' }, userId: alice.user.id, sessionId: targetId }]);

    expect((await target.get('/api/test/protected')).status).toBe(401);
    expect((await keeper.get('/api/test/protected')).status).toBe(200);
    // Révoquer deux fois, ou un identifiant inconnu → 404.
    expect((await keeper.delete(`/api/security/sessions/${targetId}`)).status).toBe(404);
    expect((await keeper.delete('/api/security/sessions/pas-un-uuid')).status).toBe(400);
  });

  it('impossible de révoquer la session de l’autre compte', async () => {
    const a = new Browser(app, uniqueIp());
    const b = new Browser(app, uniqueIp());
    await a.login(alice);
    await b.login(bob);
    const bobSessionId = (await b.get<SessionInfo[]>('/api/security/sessions')).body.data.find((s) => s.current)!.id;
    expect((await a.delete(`/api/security/sessions/${bobSessionId}`)).status).toBe(404);
    expect((await b.get('/api/test/protected')).status).toBe(200);
  });

  it('révoquer toutes les autres sessions garde la session courante', async () => {
    const keeper = new Browser(app, uniqueIp());
    const o1 = new Browser(app, uniqueIp());
    const o2 = new Browser(app, uniqueIp());
    const b = new Browser(app, uniqueIp());
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(Date.now());
    await keeper.login(alice);
    await o1.login(alice);
    await o2.login(alice);
    await b.login(bob);

    const events: BusMessage[] = [];
    const unsubscribe = subscribe((message) => events.push(message));
    const res = await keeper.post<{ revoked: number }>('/api/security/sessions/revoke-others');
    unsubscribe();
    expect(res.body.data).toEqual({ revoked: 2 });
    expect(events.length).toBe(2);
    expect(events.every((e) => e.event.type === 'session_revoked' && e.userId === alice.user.id)).toBe(true);

    expect((await keeper.get('/api/test/protected')).status).toBe(200);
    expect((await o1.get('/api/test/protected')).status).toBe(401);
    expect((await o2.get('/api/test/protected')).status).toBe(401);
    expect((await b.get('/api/test/protected')).status).toBe(200);
  });
});

describe('journal d’audit', () => {
  it('chaque compte voit son journal et les évènements non attribués, jamais celui de l’autre', async () => {
    const a = new Browser(app, uniqueIp());
    const b = new Browser(app, uniqueIp());
    await a.login(alice);
    await b.login(bob);
    // Évènement non attribué : échec sur un identifiant inconnu.
    await new Browser(app, uniqueIp()).post('/api/auth/login', { identifier: 'fantome', password: 'Peu-Importe-123456!' });
    await b.post('/api/security/sessions/revoke-others');
    const bobRevoke = db.prepare("SELECT id FROM audit_log WHERE action = 'security.session.revoke_others' AND user_id = ? ORDER BY id DESC LIMIT 1").get(bob.user.id) as { id: number };

    const ids = (userId: number | null) =>
      (db.prepare(userId === null ? 'SELECT id FROM audit_log WHERE user_id IS NULL' : 'SELECT id FROM audit_log WHERE user_id = ?').all(...(userId === null ? [] : [userId])) as { id: number }[]).map(
        (r) => r.id,
      );
    const fetchAll = async (browser: Browser) => {
      const all: AuditEntry[] = [];
      for (let page = 1; ; page += 1) {
        const res = await browser.get<AuditEntry[]>(`/api/security/audit?page=${page}&pageSize=100`);
        expect(res.status).toBe(200);
        all.push(...res.body.data);
        const meta = res.body.meta as { total: number };
        if (all.length >= meta.total) return { all, total: meta.total };
      }
    };

    const aliceView = await fetchAll(a);
    const expectedAlice = new Set([...ids(alice.user.id), ...ids(null)]);
    // La lecture du journal n'ajoute rien : les deux ensembles sont comparables.
    expect(new Set(aliceView.all.map((e) => e.id))).toEqual(expectedAlice);
    expect(aliceView.total).toBe(expectedAlice.size);
    const bobIds = new Set(ids(bob.user.id));
    expect(bobIds.size).toBeGreaterThan(0);
    expect(aliceView.all.some((e) => bobIds.has(e.id))).toBe(false);
    expect(aliceView.all.some((e) => e.id === bobRevoke.id)).toBe(false);
    expect(aliceView.all.some((e) => e.action === 'auth.login.failure' && e.success === false)).toBe(true);

    const bobView = await fetchAll(b);
    expect(bobView.all.some((e) => e.id === bobRevoke.id && e.action === 'security.session.revoke_others')).toBe(true);
    const aliceIds = new Set(ids(alice.user.id));
    expect(bobView.all.some((e) => aliceIds.has(e.id))).toBe(false);
  });

  it('pagination, ordre antichronologique, filtres `action` (préfixe) et `success`', async () => {
    const a = new Browser(app, uniqueIp());
    await a.login(alice);

    const page1 = await a.get<AuditEntry[]>('/api/security/audit?page=1&pageSize=5');
    const page2 = await a.get<AuditEntry[]>('/api/security/audit?page=2&pageSize=5');
    expect(page1.body.data.length).toBe(5);
    expect(page1.body.meta).toMatchObject({ page: 1, pageSize: 5 });
    const idsSeen = [...page1.body.data, ...page2.body.data].map((e) => e.id);
    expect(idsSeen).toEqual([...idsSeen].sort((x, y) => y - x));
    expect(new Set(idsSeen).size).toBe(idsSeen.length);
    const entry = page1.body.data[0]!;
    expect(Object.keys(entry).sort()).toEqual(['action', 'at', 'country', 'details', 'deviceLabel', 'id', 'ip', 'success', 'target', 'userAgent'].sort());
    expect(new Date(entry.at).toISOString()).toBe(entry.at);

    const logins = await a.get<AuditEntry[]>('/api/security/audit?action=auth.login.&pageSize=100');
    expect(logins.body.data.length).toBeGreaterThan(0);
    expect(logins.body.data.every((e) => e.action.startsWith('auth.login.'))).toBe(true);

    const failures = await a.get<AuditEntry[]>('/api/security/audit?success=false&pageSize=100');
    expect(failures.body.data.length).toBeGreaterThan(0);
    expect(failures.body.data.every((e) => e.success === false)).toBe(true);
    const successes = await a.get<AuditEntry[]>('/api/security/audit?success=true&action=auth.login.success');
    expect(successes.body.data.every((e) => e.success && e.action === 'auth.login.success')).toBe(true);

    // Le filtre est un préfixe littéral : les jokers SQL ne sont pas interprétés, et rien n'est injectable.
    expect((await a.get<AuditEntry[]>('/api/security/audit?action=auth_login')).body.data.length).toBe(0);
    expect((await a.get('/api/security/audit?action=%25')).status).toBe(400);
    expect((await a.get("/api/security/audit?action=x'%20OR%201=1--")).status).toBe(400);
    expect((await a.get('/api/security/audit?pageSize=101')).status).toBe(400);
    expect((await a.get('/api/security/audit?page=0')).status).toBe(400);
  });

  it('le journal est en ajout seul', () => {
    expect(() => db.prepare("UPDATE audit_log SET action = 'x'").run()).toThrow(/ajout seul/);
  });
});

describe('appareils connus', () => {
  it('lister puis oublier un appareil : la prochaine connexion depuis celui-ci redemande une confirmation', async () => {
    const laptop = new Browser(app, uniqueIp());
    const phone = new Browser(app, laptop.ip, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');
    db.prepare('DELETE FROM known_devices WHERE user_id = ?').run(bob.user.id);
    await laptop.login(bob);
    await phone.login(bob);

    const list = await laptop.get<KnownDevice[]>('/api/security/devices');
    expect(list.body.data.length).toBe(2);
    const current = list.body.data.find((d) => d.current)!;
    const other = list.body.data.find((d) => !d.current)!;
    expect(current.label).toBe('Chrome 129 · Windows');
    expect(other.label).toContain('Safari');
    expect(current.lastIp).toBe(laptop.ip);
    expect(JSON.stringify(list.body)).not.toContain(laptop.cookies.get('tc_device')!);

    // L'autre compte ne voit ni ne peut oublier ces appareils.
    const a = new Browser(app, uniqueIp());
    await a.login(alice);
    expect((await a.get<KnownDevice[]>('/api/security/devices')).body.data.some((d) => d.id === other.id)).toBe(false);
    expect((await a.delete(`/api/security/devices/${other.id}`)).status).toBe(404);

    const forget = await laptop.delete(`/api/security/devices/${other.id}`);
    expect(forget.status).toBe(200);
    expect((await laptop.get<KnownDevice[]>('/api/security/devices')).body.data.length).toBe(1);
    // La session ouverte depuis l'appareil oublié est fermée.
    expect((await phone.get('/api/test/protected')).status).toBe(401);
    const again = await phone.passwordAndSecondFactor(bob);
    expect(again.body.data.step).toBe('device_confirmation');
    expect(again.body.data.reasons).toEqual(['new_device']);
    expect((await laptop.delete(`/api/security/devices/${other.id}`)).status).toBe(404);
  });
});

describe('liste blanche d’IP (routes)', () => {
  it('GET puis PUT avec step-up ; validation de chaque entrée ; anti-enfermement', async () => {
    const admin = new Browser(app, '203.0.113.50');
    await admin.login(alice);

    const initial = await admin.get<IpAllowlist>('/api/security/ip-allowlist');
    expect(initial.body.data).toEqual({ entries: [], envEntries: [], currentIp: '203.0.113.50' });

    // Sans step-up récent : refus.
    advance(5 * 60_000 + 1000);
    const noStepUp = await admin.put('/api/security/ip-allowlist', { entries: ['203.0.113.0/24'] });
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.errorCode).toBe('STEP_UP_REQUIRED');
    expect((await admin.stepUp(alice)).status).toBe(200);

    // Entrée invalide : rien n'est enregistré.
    const invalid = await admin.put('/api/security/ip-allowlist', { entries: ['203.0.113.0/24', 'pas-une-ip', '0.0.0.0/0'] });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error?.details).toEqual({ invalid: ['pas-une-ip', '0.0.0.0/0'] });
    expect((await admin.put('/api/security/ip-allowlist', { entries: 'pas-un-tableau' as never })).status).toBe(400);

    // Liste qui exclurait l'appelant : refusée.
    const lockout = await admin.put('/api/security/ip-allowlist', { entries: ['198.18.0.0/16'] });
    expect(lockout.status).toBe(400);
    expect(lockout.body.error?.message).toContain('203.0.113.50');
    expect((await admin.get<IpAllowlist>('/api/security/ip-allowlist')).body.data.entries).toEqual([]);

    // Liste valide : normalisée, dédoublonnée, appliquée aussitôt.
    const ok = await admin.put<IpAllowlist>('/api/security/ip-allowlist', { entries: [' 203.0.113.0/24 ', '::ffff:203.0.113.0/120', '2001:DB8::1'] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.entries).toEqual(['203.0.113.0/24', '2001:db8::1']);
    expect((await new Browser(app, '198.18.0.1').get('/api/auth/session')).errorCode).toBe('IP_NOT_ALLOWED');
    expect((await admin.get('/api/test/protected')).status).toBe(200);

    // Stockée chiffrée dans l'espace de réglages « security ».
    expect(getSettings<{ ipAllowlist: string[] }>('security')?.ipAllowlist).toEqual(['203.0.113.0/24', '2001:db8::1']);
    const stored = db.prepare("SELECT data_enc FROM integration_settings WHERE namespace = 'security'").get() as { data_enc: string };
    expect(stored.data_enc).not.toContain('203.0.113');

    // Journal + alerte aux deux administrateurs.
    const mails = await alertMails("Liste blanche d'IP modifiée");
    expect(mails.length).toBe(1);
    expect(mails[0]!.to).toEqual([alice.email, bob.email]);
    const audited = db.prepare("SELECT success FROM audit_log WHERE action = 'security.ip_allowlist.update' ORDER BY id").all() as { success: number }[];
    expect(audited.map((r) => r.success)).toEqual([0, 0, 1]);

    // Vider la liste désactive le filtrage.
    expect((await admin.put<IpAllowlist>('/api/security/ip-allowlist', { entries: [] })).body.data.entries).toEqual([]);
    expect((await new Browser(app, '198.18.0.1').get('/api/auth/session')).status).toBe(200);
    setPanelAllowlist([], null);
  });
});

describe('mot de passe', () => {
  it('exige step-up + mot de passe actuel + mot de passe fort ; révoque les autres sessions ; alerte', async () => {
    const main = new Browser(app, uniqueIp());
    const other = new Browser(app, uniqueIp());
    await main.login(bob);
    await other.login(bob);
    const newPassword = 'Nouvelle!Phrase-2026-Zx';

    advance(5 * 60_000 + 1000);
    const noStepUp = await main.post('/api/security/password', { currentPassword: bob.password, newPassword });
    expect(noStepUp.errorCode).toBe('STEP_UP_REQUIRED');
    await main.stepUp(bob);

    const wrongCurrent = await main.post('/api/security/password', { currentPassword: 'Pas-Le-Bon-Mot-De-Passe-1!', newPassword });
    expect(wrongCurrent.status).toBe(401);
    expect(wrongCurrent.errorCode).toBe('INVALID_CREDENTIALS');
    // L'échec compte comme un échec d'authentification.
    expect(db.prepare('SELECT failed_attempts FROM users WHERE id = ?').get(bob.user.id)).toEqual({ failed_attempts: 1 });

    for (const weak of ['court1A!', 'toutenminuscules-123456!', 'SANSMINUSCULE-123456!', 'SansChiffre-abcdefgh!', 'SansSymbole123456abc', 'Bob-est-le-meilleur-123!', 'P@ssw0rd123456!!']) {
      const res = await main.post('/api/security/password', { currentPassword: bob.password, newPassword: weak });
      expect(res.status, weak).toBe(400);
    }
    expect((await main.post('/api/security/password', { currentPassword: bob.password, newPassword: bob.password })).status).toBe(400);
    // L'ancien mot de passe fonctionne toujours : rien n'a été modifié par les refus.
    expect((await new Browser(app, uniqueIp()).post('/api/auth/login', { identifier: 'bob', password: bob.password })).status).toBe(200);

    outbox.length = 0;
    const ok = await main.post('/api/security/password', { currentPassword: bob.password, newPassword });
    expect(ok.status).toBe(200);
    expect((await main.get('/api/test/protected')).status).toBe(200);
    expect((await other.get('/api/test/protected')).status).toBe(401);

    advance(61_000);
    const oldLogin = await new Browser(app, uniqueIp()).post('/api/auth/login', { identifier: 'bob', password: bob.password });
    expect(oldLogin.status).toBe(401);
    bob.password = newPassword;
    const newLogin = await new Browser(app, uniqueIp()).post<LoginStepResponse>('/api/auth/login', { identifier: 'bob', password: newPassword });
    expect(newLogin.status).toBe(200);

    const mails = await alertMails('Mot de passe modifié : bob');
    expect(mails.length).toBe(1);
    expect(mails[0]!.to).toEqual([alice.email, bob.email]);
    // Ni l'ancien ni le nouveau mot de passe dans le journal ou les mails.
    const dump = JSON.stringify([db.prepare('SELECT * FROM audit_log').all(), outbox]);
    expect(dump).not.toContain(newPassword);
    expect(dump).not.toContain('Pas-Le-Bon-Mot-De-Passe-1!');
  });
});

describe('TOTP', () => {
  it('regenerate (step-up) place un secret en attente ; confirm l’active ; l’ancien ne vaut plus', async () => {
    const main = new Browser(app, uniqueIp());
    const other = new Browser(app, uniqueIp());
    await main.login(alice);
    await other.login(alice);
    const oldSecret = alice.totpSecret;

    advance(5 * 60_000 + 1000);
    expect((await main.post('/api/security/totp/regenerate')).errorCode).toBe('STEP_UP_REQUIRED');
    // Confirmer sans secret en attente : refus.
    expect((await main.post('/api/security/totp/confirm', { code: totpCode(oldSecret) })).status).toBe(400);
    await main.stepUp(alice);

    const setup = await main.post<TotpSetup>('/api/security/totp/regenerate');
    expect(setup.status).toBe(200);
    const { secret, otpauthUrl, qrDataUrl } = setup.body.data;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(secret).not.toBe(oldSecret);
    expect(otpauthUrl).toBe(`otpauth://totp/TalCloud%20Panel:alice?secret=${secret}&issuer=TalCloud%20Panel`);
    expect(qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(setup.raw.headers['cache-control']).toBe('no-store');
    // En base : chiffré, et l'ancien secret reste actif tant que le nouveau n'est pas confirmé.
    expect(JSON.stringify(db.prepare('SELECT * FROM users').all())).not.toContain(secret);
    expect(JSON.stringify(db.prepare('SELECT details FROM audit_log').all())).not.toContain(secret);

    // Un code de l'ANCIEN secret ne confirme pas le nouveau.
    const wrong = await main.post('/api/security/totp/confirm', { code: freshTotp(oldSecret) });
    expect(wrong.status).toBe(401);
    // L'ancien secret permet toujours le step-up.
    expect((await main.stepUp(alice)).status).toBe(200);

    outbox.length = 0;
    advance(30_000);
    const confirm = await main.post('/api/security/totp/confirm', { code: totpCode(secret) });
    expect(confirm.status).toBe(200);
    alice.totpSecret = secret;
    expect((await other.get('/api/test/protected')).status).toBe(401);
    expect((await main.get('/api/test/protected')).status).toBe(200);

    // L'ancien secret est refusé ; le code de confirmation ne peut pas être rejoué ; le nouveau secret fonctionne.
    advance(5 * 60_000 + 1000);
    expect((await main.post('/api/auth/step-up', { totpCode: totpCode(oldSecret) })).status).toBe(401);
    expect((await main.stepUp(alice)).status).toBe(200);
    const fresh = new Browser(app, uniqueIp());
    await fresh.login(alice);

    const mails = await alertMails('Double authentification modifiée : alice');
    expect(mails.length).toBe(1);
    // Confirmer une seconde fois : plus de secret en attente.
    expect((await main.post('/api/security/totp/confirm', { code: freshTotp(secret) })).status).toBe(400);
  });

  it('un secret en attente jamais confirmé expire', async () => {
    const main = new Browser(app, uniqueIp());
    await main.login(alice);
    const setup = await main.post<TotpSetup>('/api/security/totp/regenerate');
    expect(setup.status).toBe(200);
    advance(14 * 60_000);
    await main.get('/api/test/protected');
    advance(2 * 60_000);
    const late = await main.post('/api/security/totp/confirm', { code: totpCode(setup.body.data.secret) });
    expect(late.status).toBe(400);
    expect(db.prepare('SELECT totp_pending_enc FROM users WHERE id = ?').get(alice.user.id)).toEqual({ totp_pending_enc: null });
  });
});

describe('codes de secours', () => {
  it('nombre restant, puis régénération (step-up) : les anciens ne valent plus', async () => {
    const main = new Browser(app, uniqueIp());
    await main.login(alice);
    const status = await main.get<BackupCodesStatus>('/api/security/backup-codes');
    expect(status.body.data).toEqual({ remaining: 10, total: 10 });

    advance(5 * 60_000 + 1000);
    expect((await main.post('/api/security/backup-codes/regenerate')).errorCode).toBe('STEP_UP_REQUIRED');
    await main.stepUp(alice);
    outbox.length = 0;
    const regen = await main.post<BackupCodes>('/api/security/backup-codes/regenerate');
    expect(regen.status).toBe(200);
    const codes = regen.body.data.codes;
    expect(codes.length).toBe(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(codes.some((c) => alice.backupCodes.includes(c))).toBe(false);

    // Les codes ne sont ni dans le journal ni dans le mail d'alerte.
    const mails = await alertMails('Codes de secours régénérés : alice');
    expect(mails.length).toBe(1);
    const dump = JSON.stringify([db.prepare('SELECT * FROM audit_log').all(), db.prepare('SELECT * FROM backup_codes').all(), outbox]);
    for (const code of codes) {
      expect(dump).not.toContain(code);
      expect(dump).not.toContain(code.replace(/-/g, ''));
    }

    // Ancien code refusé, nouveau code accepté une fois.
    const login = new Browser(app, uniqueIp());
    await login.post('/api/auth/login', { identifier: 'alice', password: alice.password });
    const old = await login.post('/api/auth/login/verify', { emailCode: mailedCode(alice.email, 'Code de connexion'), backupCode: alice.backupCodes[0]! });
    expect(old.status).toBe(401);
    const fresh = await login.post<LoginStepResponse>('/api/auth/login/verify', { emailCode: mailedCode(alice.email, 'Code de connexion'), backupCode: codes[0]! });
    expect(fresh.status).toBe(200);
    alice.backupCodes = codes;
    expect((await main.get<BackupCodesStatus>('/api/security/backup-codes')).body.data).toEqual({ remaining: 9, total: 10 });
  });
});

describe('toutes les routes /api/security exigent une session', () => {
  it('401 sans session, quelle que soit la méthode', async () => {
    const anonymous = new Browser(app, uniqueIp());
    const routes: ['GET' | 'POST' | 'PUT' | 'DELETE', string][] = [
      ['GET', '/api/security/sessions'],
      ['DELETE', '/api/security/sessions/00000000-0000-4000-8000-000000000000'],
      ['POST', '/api/security/sessions/revoke-others'],
      ['GET', '/api/security/audit'],
      ['GET', '/api/security/devices'],
      ['DELETE', '/api/security/devices/1'],
      ['GET', '/api/security/ip-allowlist'],
      ['PUT', '/api/security/ip-allowlist'],
      ['POST', '/api/security/password'],
      ['POST', '/api/security/totp/regenerate'],
      ['POST', '/api/security/totp/confirm'],
      ['GET', '/api/security/backup-codes'],
      ['POST', '/api/security/backup-codes/regenerate'],
      ['POST', '/api/auth/logout'],
      ['POST', '/api/auth/step-up'],
    ];
    for (const [method, url] of routes) {
      const res = await anonymous.request(method, url, { body: {} });
      expect(res.status, `${method} ${url}`).toBe(401);
      expect(res.errorCode).toBe('UNAUTHENTICATED');
      advance(7000);
    }
  });
});
