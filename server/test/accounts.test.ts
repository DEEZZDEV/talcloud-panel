import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { generateSync } from 'otplib';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { decrypt } from '../src/core/crypto.js';
import { db } from '../src/db/index.js';
import { canCreateAdmin, createAdmin, emailProblem, usernameProblem } from '../src/modules/auth/admin.js';
import { normalizeBackupCode } from '../src/modules/auth/backup-codes.js';
import { passwordProblems, verifyPassword } from '../src/modules/auth/passwords.js';
import { decryptTotpSecret, matchTotpStep, newTotpSecret } from '../src/modules/auth/totp.js';
import { createTestAdmin } from './helpers.js';

describe('règles de mot de passe', () => {
  const ctx = { username: 'alice', email: 'alice.martin@talhost.fr' };

  it('accepte un mot de passe fort', () => {
    expect(passwordProblems('Tr3s-Solide!Phrase-7-Zq', ctx)).toEqual([]);
    expect(passwordProblems('cheval Batterie 42 agrafe!', ctx)).toEqual([]);
  });

  it('refuse : trop court, classes de caractères manquantes', () => {
    expect(passwordProblems('Court1!aB', ctx)).toContain('au moins 14 caractères');
    expect(passwordProblems('A1!defghijklm', ctx)).toContain('au moins 14 caractères'); // 13 caractères
    expect(passwordProblems('toutenminuscules-123456!', ctx)).toContain('au moins une majuscule');
    expect(passwordProblems('TOUTENMAJUSCULES-123456!', ctx)).toContain('au moins une minuscule');
    expect(passwordProblems('SansChiffre-abcdefgh!', ctx)).toContain('au moins un chiffre');
    expect(passwordProblems('SansSymbole123456abc', ctx)).toContain('au moins un symbole');
    expect(passwordProblems('Aa1!Aa1!Aa1!Aa1!', ctx)).toContain('au moins 8 caractères différents');
    expect(passwordProblems(`Aa1!${'x'.repeat(300)}`, ctx)).toContain('au plus 200 caractères');
  });

  it("refuse un mot de passe contenant le nom d'utilisateur ou l'e-mail", () => {
    expect(passwordProblems('Alice-est-geniale-2026!', ctx)).toContain("ne doit pas contenir le nom d'utilisateur");
    expect(passwordProblems('xX-ALICE.MARTIN-Xx-2026!', ctx)).toContain("ne doit pas contenir l'adresse e-mail");
    expect(passwordProblems('Vive-Martin-Et-Compagnie-9!', ctx)).toContain("ne doit pas contenir l'adresse e-mail");
    expect(passwordProblems('Mon-Talhost-Prefere-2026!', ctx)).toContain("ne doit pas contenir l'adresse e-mail");
  });

  it('refuse les mots de passe courants, même décorés ou en « leet »', () => {
    for (const common of ['Password123456!', 'P@ssw0rd123456!!', 'MotDePasse-2026!', 'Azertyuiop-123456!', 'Qwerty-123456789!', 'Admin-123456789!!', 'Welcome-2026-2026!', 'TalCloud-Panel-2026!', 'Ch4ngeMe-Maintenant-1!']) {
      expect(passwordProblems(common, ctx), common).toContain('trop courant ou trop prévisible');
    }
  });
});

describe('comptes : 2 au maximum, créés uniquement hors HTTP', () => {
  it('hash Argon2id (m ≥ 64 MiB, t ≥ 3), secret TOTP chiffré et lié au compte, codes de secours hachés', async () => {
    const first = await createTestAdmin('alice');
    const second = await createTestAdmin('bob');
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(first.user.id) as { password_hash: string; totp_secret_enc: string };

    const params = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(row.password_hash)!;
    expect(Number(params[1])).toBeGreaterThanOrEqual(65_536);
    expect(Number(params[2])).toBeGreaterThanOrEqual(3);
    expect(Number(params[3])).toBe(1);
    expect(await verifyPassword(row.password_hash, first.password)).toBe(true);
    expect(await verifyPassword(row.password_hash, `${first.password}x`)).toBe(false);
    expect(await verifyPassword('pas-un-hash', first.password)).toBe(false);

    expect(row.totp_secret_enc.startsWith('v1:')).toBe(true);
    expect(row.totp_secret_enc).not.toContain(first.totpSecret);
    expect(decryptTotpSecret(first.user.id, row.totp_secret_enc)).toBe(first.totpSecret);
    // Le chiffré est lié au compte : il est indéchiffrable dans le contexte d'un autre compte ou sans contexte.
    expect(() => decryptTotpSecret(second.user.id, row.totp_secret_enc)).toThrow();
    expect(() => decrypt(row.totp_secret_enc)).toThrow();

    expect(first.backupCodes.length).toBe(10);
    expect(new Set(first.backupCodes).size).toBe(10);
    const stored = db.prepare('SELECT code_hash, used_at FROM backup_codes WHERE user_id = ?').all(first.user.id) as { code_hash: string; used_at: number | null }[];
    expect(stored.length).toBe(10);
    for (const { code_hash, used_at } of stored) {
      expect(code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(used_at).toBeNull();
    }
    expect(normalizeBackupCode('abcd-efgh-jk0o')).toBe('ABCDEFGHJK00');
    expect(normalizeBackupCode('trop-court')).toBeNull();
    expect(normalizeBackupCode('ABCD-EFGH-JKU!')).toBeNull();
  });

  it('impossible d’insérer un 3ᵉ compte : refus applicatif ET déclencheur SQL', async () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 2 });
    expect(canCreateAdmin()).toBe(false);
    await expect(createAdmin({ username: 'carol', email: 'carol@exemple.test', password: 'Tr3s-Solide!Phrase-3-Zq', totpSecret: newTotpSecret() })).rejects.toThrow(/Limite de 2 comptes/);

    // Même en contournant l'application (SQL direct), la base refuse.
    const insert = () =>
      db
        .prepare('INSERT INTO users (username, email, password_hash, totp_secret_enc, password_changed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('mallory', 'mallory@exemple.test', 'x', 'x', Date.now(), Date.now());
    expect(insert).toThrow(/Limite de 2 comptes administrateurs atteinte/);
    expect(() => db.exec("INSERT INTO users (username, email, password_hash, totp_secret_enc, password_changed_at, created_at) SELECT 'm2', 'm2@x.test', 'x', 'x', 0, 0")).toThrow(/Limite de 2 comptes/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 2 });
  });

  it('nom d’utilisateur et e-mail : format et unicité (insensible à la casse)', () => {
    expect(usernameProblem('ALICE')).toMatch(/déjà pris/);
    expect(usernameProblem('ab')).not.toBeNull();
    expect(usernameProblem('avec espace')).not.toBeNull();
    expect(usernameProblem('a@b.fr')).not.toBeNull();
    expect(usernameProblem('carol')).toBeNull();
    expect(emailProblem('pas-un-mail')).not.toBeNull();
    expect(emailProblem('Alice@Exemple.Test')).toMatch(/déjà utilisée/);
    expect(emailProblem('carol@exemple.test')).toBeNull();
  });

  it('TOTP : fenêtre ±1 pas et anti-rejeu', () => {
    // Horloge figée : le test ne dépend pas du franchissement d'un pas de 30 s pendant son exécution.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T10:00:07Z') });
    onTestFinished(() => void vi.useRealTimers());
    const secret = newTotpSecret();
    const now = Math.floor(Date.now() / 1000);
    const at = (offset: number) => generateSync({ secret, epoch: now + offset * 30 });
    const currentStep = Math.floor(now / 30);
    expect(matchTotpStep(secret, at(0), 0)).toBe(currentStep);
    expect(matchTotpStep(secret, at(-1), 0)).toBe(currentStep - 1);
    expect(matchTotpStep(secret, at(1), 0)).toBe(currentStep + 1);
    expect(matchTotpStep(secret, at(-2), 0)).toBeNull();
    expect(matchTotpStep(secret, at(2), 0)).toBeNull();
    expect(matchTotpStep(secret, at(0), currentStep)).toBeNull();
    expect(matchTotpStep(secret, at(-1), currentStep)).toBeNull();
    expect(matchTotpStep(secret, at(1), currentStep)).toBe(currentStep + 1);
    expect(matchTotpStep(secret, 'abcdef', 0)).toBeNull();
    expect(matchTotpStep(secret, '', 0)).toBeNull();
    expect(matchTotpStep(secret, '1234567', 0)).toBeNull();
  });
});

describe('CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'talcloud-cli-'));
  const dbPath = join(dir, 'cli.db');
  const serverDir = resolve(import.meta.dirname, '..');
  const tsx = join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let inspect: Database.Database;

  /**
   * Lance la CLI comme un utilisateur : écrit les réponses sur l'entrée standard. Une réponse peut être une
   * fonction de la sortie déjà affichée (pour calculer le code TOTP à partir du secret imprimé).
   */
  function runCli(args: string[], answers: (string | ((output: string) => string | null))[] = []): Promise<{ code: number | null; output: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [tsx, 'src/cli/index.ts', ...args], {
        cwd: serverDir,
        env: { ...process.env, NODE_ENV: 'test', DB_PATH: dbPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      const queue = [...answers];
      let answeredAt = -1;
      const feed = () => {
        // La CLI attend une saisie quand sa sortie se termine par une question (« … : ») encore sans réponse.
        if (!queue.length || !output.endsWith(': ') || output.length === answeredAt) return;
        const next = queue[0]!;
        const value = typeof next === 'function' ? next(output) : next;
        if (value === null) return;
        queue.shift();
        answeredAt = output.length;
        child.stdin.write(`${value}
`);
        if (!queue.length) child.stdin.end();
      };
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        feed();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      if (!answers.length) child.stdin.end();
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`CLI trop lente. Sortie :\n${output}`));
      }, 60_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ code, output });
      });
    });
  }

  const totpFromOutput = (output: string): string | null => {
    const secret = /Secret : ([A-Z2-7]+)/.exec(output)?.[1];
    return secret ? generateSync({ secret }) : null;
  };
  const backupCodesIn = (output: string): string[] => output.match(/^ {4}[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/gm)?.map((c) => c.trim()) ?? [];

  beforeAll(() => {
    inspect = new Database(dbPath);
  });

  afterAll(() => {
    inspect.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('create-admin : refuse un mot de passe faible, exige un TOTP valide AVANT d’enregistrer, affiche 10 codes de secours', async () => {
    const password = 'Tr3s-Solide!Phrase-CLI-1';
    const { code, output } = await runCli(['create-admin'], [
      'ab', // nom trop court → redemandé
      'premier',
      'pas-un-mail', // → redemandé
      'premier@exemple.test',
      'faible', // → refusé
      password,
      'ne-correspond-pas', // confirmation différente → on recommence
      password,
      password,
      '000000', // code TOTP faux → redemandé, rien n'est enregistré
      totpFromOutput,
    ]);
    expect(code, output).toBe(0);
    expect(output).toContain('otpauth://totp/TalCloud%20Panel:premier?secret=');
    expect(output).toContain('Refusé');
    expect(output).toContain('Les deux saisies ne correspondent pas');
    expect(output).toContain('Code incorrect');
    expect(output).toContain('Compte « premier » créé');
    expect(backupCodesIn(output).length).toBe(10);

    const user = inspect.prepare('SELECT * FROM users').get() as { id: number; username: string; email: string; password_hash: string; totp_secret_enc: string };
    expect(user.username).toBe('premier');
    expect(user.email).toBe('premier@exemple.test');
    expect(user.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(user.totp_secret_enc).not.toContain(/Secret : ([A-Z2-7]+)/.exec(output)![1]!);
    expect(inspect.prepare('SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ?').get(user.id)).toEqual({ n: 10 });
    expect(inspect.prepare("SELECT user_id, action FROM audit_log WHERE action LIKE 'cli.%'").all()).toEqual([{ user_id: user.id, action: 'cli.admin.create' }]);
  });

  it('create-admin : sans code TOTP valide, aucun compte n’est créé', async () => {
    const password = 'Tr3s-Solide!Phrase-CLI-X';
    const { code, output } = await runCli(['create-admin'], ['fantome', 'fantome@exemple.test', password, password, '000000', '000000', '000000', '000000', '000000']);
    expect(code).toBe(1);
    expect(output).toContain('rien n’a été enregistré');
    expect(inspect.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
  });

  it('create-admin : refuse un 3ᵉ compte avec un message clair', async () => {
    const password = 'Tr3s-Solide!Phrase-CLI-2';
    const second = await runCli(['create-admin'], ['second', 'second@exemple.test', password, password, totpFromOutput]);
    expect(second.code, second.output).toBe(0);
    const third = await runCli(['create-admin']);
    expect(third.code).toBe(1);
    expect(third.output).toContain('Limite atteinte : 2 comptes administrateurs existent déjà');
    expect(inspect.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 2 });
  });

  it('list-admins, unlock, revoke-sessions', async () => {
    inspect.prepare("UPDATE users SET failed_attempts = 3, lock_count = 2, locked_until = ? WHERE username = 'premier'").run(Date.now() + 3_600_000);
    const user = inspect.prepare("SELECT id FROM users WHERE username = 'premier'").get() as { id: number };
    inspect
      .prepare("INSERT INTO sessions (id, token_hash, user_id, csrf_token, ip, user_agent, created_at, last_seen_at, expires_at) VALUES ('s1', 'h1', ?, 'c', '203.0.113.1', 'ua', ?, ?, ?)")
      .run(user.id, Date.now(), Date.now(), Date.now() + 3_600_000);

    const list = await runCli(['list-admins']);
    expect(list.code).toBe(0);
    expect(list.output).toContain('premier  <premier@exemple.test>');
    expect(list.output).toContain('second  <second@exemple.test>');
    expect(list.output).toContain('VERROUILLÉ');
    // Aucun secret dans la liste.
    expect(list.output).not.toContain('$argon2id$');
    expect(list.output).not.toContain('v1:');

    const unlock = await runCli(['unlock', 'premier']);
    expect(unlock.code).toBe(0);
    expect(inspect.prepare("SELECT failed_attempts, lock_count, locked_until FROM users WHERE username = 'premier'").get()).toEqual({ failed_attempts: 0, lock_count: 0, locked_until: null });

    const revoke = await runCli(['revoke-sessions', 'premier@exemple.test']);
    expect(revoke.code).toBe(0);
    expect(revoke.output).toContain('Sessions fermées pour « premier » : 1');
    expect((inspect.prepare("SELECT revoked_at FROM sessions WHERE id = 's1'").get() as { revoked_at: number | null }).revoked_at).not.toBeNull();

    const unknown = await runCli(['unlock', 'personne']);
    expect(unknown.code).toBe(1);
    expect(unknown.output).toContain('Compte introuvable');
    expect((await runCli(['commande-inconnue'])).code).toBe(1);

    const actions = (inspect.prepare("SELECT action, user_id FROM audit_log WHERE action IN ('cli.account.unlock', 'cli.sessions.revoke')").all() as { action: string; user_id: number }[]).sort((a, b) =>
      a.action.localeCompare(b.action),
    );
    expect(actions).toEqual([
      { action: 'cli.account.unlock', user_id: user.id },
      { action: 'cli.sessions.revoke', user_id: user.id },
    ]);
  });

  it('reset-password et reset-2fa : nouveaux secrets, sessions fermées, journal', async () => {
    const before = inspect.prepare("SELECT id, password_hash, totp_secret_enc FROM users WHERE username = 'second'").get() as { id: number; password_hash: string; totp_secret_enc: string };
    const oldCodes = (inspect.prepare('SELECT code_hash FROM backup_codes WHERE user_id = ?').all(before.id) as { code_hash: string }[]).map((r) => r.code_hash);

    const newPassword = 'Encore!Plus-Solide-2026-Qz';
    const reset = await runCli(['reset-password', 'second'], ['second-est-faible', newPassword, newPassword]);
    expect(reset.code, reset.output).toBe(0);
    const afterPassword = inspect.prepare('SELECT password_hash FROM users WHERE id = ?').get(before.id) as { password_hash: string };
    expect(afterPassword.password_hash).not.toBe(before.password_hash);
    expect(await verifyPassword(afterPassword.password_hash, newPassword)).toBe(true);

    const reset2fa = await runCli(['reset-2fa', 'second'], [totpFromOutput]);
    expect(reset2fa.code, reset2fa.output).toBe(0);
    const afterTotp = inspect.prepare('SELECT totp_secret_enc FROM users WHERE id = ?').get(before.id) as { totp_secret_enc: string };
    expect(afterTotp.totp_secret_enc).not.toBe(before.totp_secret_enc);
    const newCodes = backupCodesIn(reset2fa.output);
    expect(newCodes.length).toBe(10);
    const newHashes = (inspect.prepare('SELECT code_hash FROM backup_codes WHERE user_id = ?').all(before.id) as { code_hash: string }[]).map((r) => r.code_hash);
    expect(newHashes.length).toBe(10);
    expect(newHashes.some((h) => oldCodes.includes(h))).toBe(false);

    const actions = (inspect.prepare("SELECT action FROM audit_log WHERE user_id = ? AND action LIKE 'cli.%' ORDER BY id").all(before.id) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['cli.admin.create', 'cli.password.reset', 'cli.totp.reset']);
    // Ni mot de passe ni secret dans le journal.
    const dump = JSON.stringify(inspect.prepare('SELECT * FROM audit_log').all());
    expect(dump).not.toContain(newPassword);
    expect(dump).not.toContain(/Secret : ([A-Z2-7]+)/.exec(reset2fa.output)![1]!);
  });
});
