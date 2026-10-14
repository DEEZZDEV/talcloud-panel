/**
 * AUDIT 3 (authentification) — C-02 : une connexion en cours qui a DÉJÀ franchi le second facteur survit au
 * remplacement de ce second facteur depuis le panel.
 *
 * La CLI (`setTotpSecret`, admin.ts:93-98) et le changement de mot de passe (`setPassword`, admin.ts:82-88) suppriment
 * les login_challenges du compte. Mais `POST /api/security/totp/confirm` (security.ts:335-340) et
 * `POST /api/security/backup-codes/regenerate` (security.ts:358-371) ne le font pas : un challenge à l'étape
 * `device_confirmation` — obtenu avec le mot de passe, le code mail et un code 2FA / de secours volé — reste valable
 * jusqu'à 10 minutes après que le titulaire a réagi en changeant sa 2FA ou ses codes de secours.
 */
import type { LoginStepResponse, TotpSetup } from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { generateSync } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAlertThrottle } from '../src/core/alerts.js';
import { outbox } from '../src/core/mailer.js';
import { db } from '../src/db/index.js';
import { advance, Browser, buildTestApp, createTestAdmin, freshTotp, mailedCode, uniqueIp, useFakeClock, type TestAdmin } from './helpers.js';

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

beforeEach(() => {
  advance(26 * 3600_000);
  db.exec('DELETE FROM auth_failures; DELETE FROM auth_ip_blocks; DELETE FROM login_challenges;');
  outbox.length = 0;
  resetAlertThrottle();
});

/** L'attaquant (nouvel appareil, nouvelle IP) franchit mot de passe + code mail + code de secours volé. */
async function attackerAtDeviceStage(admin: TestAdmin, secondFactor: { backupCode: string } | { totpCode: string }): Promise<Browser> {
  const attacker = new Browser(app, uniqueIp());
  expect((await attacker.post('/api/auth/login', { identifier: admin.username, password: admin.password })).status).toBe(200);
  const second = await attacker.post<LoginStepResponse>('/api/auth/login/verify', {
    emailCode: mailedCode(admin.email, 'Code de connexion'),
    ...secondFactor,
  });
  expect(second.status).toBe(200);
  expect(second.body.data.step).toBe('device_confirmation');
  return attacker;
}

describe('C-02 — challenge à l’étape « confirmation d’appareil » non invalidé par le changement de second facteur', () => {
  it('après régénération des codes de secours par le titulaire, le challenge obtenu avec un ancien code est abandonné', async () => {
    const owner = new Browser(app, uniqueIp());
    await owner.login(alice);

    const attacker = await attackerAtDeviceStage(alice, { backupCode: alice.backupCodes[0]! });
    const deviceCode = mailedCode(alice.email, 'Confirmation de connexion');

    // Le titulaire voit l'alerte « code de secours utilisé » et régénère ses codes (step-up ouvert par la connexion).
    expect((await owner.stepUp(alice)).status).toBe(200);
    const regenerated = await owner.post('/api/security/backup-codes/regenerate');
    expect(regenerated.status).toBe(200);

    const done = await attacker.post<LoginStepResponse>('/api/auth/login/confirm-device', { code: deviceCode });
    expect(done.status, 'la connexion de l’attaquant aboutit malgré la régénération des codes').toBe(401);
  });

  it('après remplacement du secret 2FA par le titulaire, le challenge déjà passé au second facteur est abandonné', async () => {
    const owner = new Browser(app, uniqueIp());
    await owner.login(bob);

    const attacker = await attackerAtDeviceStage(bob, { backupCode: bob.backupCodes[0]! });
    const deviceCode = mailedCode(bob.email, 'Confirmation de connexion');

    expect((await owner.stepUp(bob)).status).toBe(200);
    const setup = await owner.post<TotpSetup>('/api/security/totp/regenerate');
    expect(setup.status).toBe(200);
    advance(30_000);
    const confirm = await owner.post('/api/security/totp/confirm', { code: generateSync({ secret: setup.body.data.secret }) });
    expect(confirm.status).toBe(200);
    bob.totpSecret = setup.body.data.secret;

    const done = await attacker.post<LoginStepResponse>('/api/auth/login/confirm-device', { code: deviceCode });
    expect(done.status, 'la connexion de l’attaquant aboutit malgré le nouveau secret 2FA').toBe(401);
  });

  it('vérifié — le changement de mot de passe, lui, abandonne bien les connexions en cours', async () => {
    const owner = new Browser(app, uniqueIp());
    await owner.login(alice);
    const attacker = await attackerAtDeviceStage(alice, { totpCode: freshTotp(alice.totpSecret) });
    const deviceCode = mailedCode(alice.email, 'Confirmation de connexion');

    expect((await owner.stepUp(alice)).status).toBe(200);
    const newPassword = 'Autre-Phrase!Solide-2026-Qx';
    expect((await owner.post('/api/security/password', { currentPassword: alice.password, newPassword })).status).toBe(200);
    alice.password = newPassword;

    expect((await attacker.post('/api/auth/login/confirm-device', { code: deviceCode })).status).toBe(401);
  });
});
