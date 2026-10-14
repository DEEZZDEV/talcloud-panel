/**
 * CLI d'installation et de secours de TalCloud Panel.
 *
 *   Développement : npm run cli -- <commande>
 *   Production    : node dist/cli.js <commande>
 *   Docker        : docker compose run --rm panel node dist/cli.js <commande>
 *
 * C'est le SEUL moyen de créer un compte administrateur. Les commandes de secours supposent un accès shell
 * au serveur ; toutes sont inscrites au journal d'audit (action « cli.* »).
 */
import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';
import qrcodeTerminal from 'qrcode-terminal';
import { flushAlerts, securityAlert } from '../core/alerts.js';
import { audit } from '../core/audit.js';
import { db } from '../db/index.js';
import {
  canCreateAdmin,
  createAdmin,
  emailProblem,
  regenerateBackupCodes,
  revokeUserSessions,
  setPassword,
  setTotpSecret,
  unlockAccount,
  usernameProblem,
} from '../modules/auth/admin.js';
import { backupCodesStatus } from '../modules/auth/backup-codes.js';
import { getPanelAllowlist, setPanelAllowlist } from '../modules/auth/ip-allowlist.js';
import { lockRemainingSeconds, unknownDeviceLockRemainingSeconds } from '../modules/auth/lockout.js';
import { passwordProblems, PASSWORD_MIN_LENGTH } from '../modules/auth/passwords.js';
import { matchTotpStep, newTotpSecret, totpUri } from '../modules/auth/totp.js';
import { removeAllPush } from '../modules/notifications/push.js';
import { findUserByIdentifier, listUsers, MAX_ADMINS, type UserRow } from '../modules/auth/users.js';

class CliError extends Error {}

/** Saisie interactive. Dans un terminal, les secrets sont saisis sans écho ; sinon les lignes sont lues sur l'entrée standard. */
class Prompter {
  private readonly rl: Interface;
  private readonly tty = process.stdin.isTTY === true;
  private muted = false;
  private readonly lines: string[] = [];
  private readonly waiters: ((line: string | null) => void)[] = [];
  private closed = false;

  constructor() {
    const output = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        if (!this.muted) process.stdout.write(chunk);
        callback();
      },
    });
    this.rl = createInterface({ input: process.stdin, output, terminal: this.tty });
    this.rl.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    });
    this.rl.on('close', () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
    this.rl.on('SIGINT', () => {
      process.stdout.write('\nAnnulé.\n');
      process.exit(130);
    });
  }

  private nextLine(): Promise<string | null> {
    const buffered = this.lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async ask(question: string, options: { hidden?: boolean } = {}): Promise<string> {
    if (this.tty) {
      // La question est l'invite de readline : elle est réaffichée correctement lors d'une correction de saisie.
      this.rl.setPrompt(question);
      this.rl.prompt();
    } else {
      process.stdout.write(question);
    }
    this.muted = options.hidden === true && this.tty;
    const line = await this.nextLine();
    if (this.muted) {
      this.muted = false;
      process.stdout.write('\n');
    }
    if (line === null) throw new CliError('Entrée interrompue.');
    return options.hidden ? line : line.trim();
  }

  close(): void {
    this.rl.close();
  }
}

const prompterRef: { current: Prompter | null } = { current: null };
const prompt = (): Prompter => (prompterRef.current ??= new Prompter());
const print = (text = ''): void => void process.stdout.write(`${text}\n`);

function requireUser(identifier: string | undefined): UserRow {
  if (!identifier) throw new CliError("Précisez le nom d'utilisateur (ou l'e-mail) du compte.");
  const user = findUserByIdentifier(identifier);
  if (!user) throw new CliError(`Compte introuvable : ${identifier}`);
  return user;
}

async function askNewPassword(context: { username: string; email: string }): Promise<string> {
  print(`Mot de passe : au moins ${PASSWORD_MIN_LENGTH} caractères, avec minuscule, majuscule, chiffre et symbole.`);
  for (;;) {
    const password = await prompt().ask('Mot de passe (saisie masquée) : ', { hidden: true });
    const problems = passwordProblems(password, context);
    if (problems.length) {
      print(`  Refusé : ${problems.join(', ')}.`);
      continue;
    }
    const confirmation = await prompt().ask('Confirmez le mot de passe : ', { hidden: true });
    if (confirmation !== password) {
      print('  Les deux saisies ne correspondent pas.');
      continue;
    }
    return password;
  }
}

/** Affiche le QR code et exige un code valide : garantit que l'application 2FA est bien configurée avant d'enregistrer. */
async function enrollTotp(username: string): Promise<{ secret: string; step: number }> {
  const secret = newTotpSecret();
  const uri = totpUri(username, secret);
  print();
  print('Scannez ce QR code avec votre application 2FA (Aegis, 2FAS, Google Authenticator, Bitwarden…) :');
  print();
  await new Promise<void>((resolve) => {
    qrcodeTerminal.generate(uri, { small: true }, (qr) => {
      print(qr);
      resolve();
    });
  });
  print(`URI    : ${uri}`);
  print(`Secret : ${secret}`);
  print();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const code = await prompt().ask('Code à 6 chiffres affiché par l’application : ');
    const step = matchTotpStep(secret, code, 0);
    if (step !== null) return { secret, step };
    print("  Code incorrect. Vérifiez l'heure de l'appareil et réessayez avec le code courant.");
  }
  throw new CliError('Trop de codes incorrects : rien n’a été enregistré.');
}

function printBackupCodes(codes: string[]): void {
  print();
  print('Codes de secours (à usage unique, remplacent le code 2FA). ILS NE SERONT PLUS JAMAIS AFFICHÉS :');
  print();
  for (const code of codes) print(`    ${code}`);
  print();
  print('Conservez-les hors ligne (gestionnaire de mots de passe, papier en lieu sûr).');
}

function cliAlert(title: string, summary: string, user: UserRow | null): void {
  securityAlert({
    kind: 'admin_cli',
    severity: 'critical',
    title,
    summary: `${summary} Action effectuée en ligne de commande sur le serveur.`,
    facts: user ? [['Compte', user.username]] : [],
    userId: user?.id ?? null,
  });
}

const commands: Record<string, { usage: string; description: string; run: (args: string[]) => Promise<void> }> = {
  'create-admin': {
    usage: 'create-admin',
    description: `Crée un compte administrateur (${MAX_ADMINS} au maximum), avec 2FA et codes de secours.`,
    async run() {
      if (!canCreateAdmin()) {
        throw new CliError(`Limite atteinte : ${MAX_ADMINS} comptes administrateurs existent déjà. Aucun autre compte ne peut être créé.`);
      }
      print('Création d’un compte administrateur');
      print();

      let username = '';
      for (;;) {
        username = await prompt().ask("Nom d'utilisateur : ");
        const problem = usernameProblem(username);
        if (!problem) break;
        print(`  ${problem}`);
      }
      let email = '';
      for (;;) {
        email = (await prompt().ask('Adresse e-mail (codes de connexion et alertes) : ')).toLowerCase();
        const problem = emailProblem(email);
        if (!problem) break;
        print(`  ${problem}`);
      }
      const password = await askNewPassword({ username, email });
      const { secret, step } = await enrollTotp(username);

      const { user, backupCodes } = await createAdmin({ username, email, password, totpSecret: secret, totpStep: step });
      audit(null, { action: 'cli.admin.create', target: `compte ${user.username}`, userId: user.id });
      print();
      print(`Compte « ${user.username} » créé.`);
      printBackupCodes(backupCodes);
      cliAlert(`Compte administrateur créé : ${user.username}`, `Le compte administrateur ${user.username} vient d'être créé.`, user);
    },
  },

  'list-admins': {
    usage: 'list-admins',
    description: 'Liste les comptes administrateurs et leur état.',
    async run() {
      const users = listUsers();
      if (!users.length) {
        print('Aucun compte. Créez-en un avec : create-admin');
        return;
      }
      const now = Date.now();
      for (const user of users) {
        const locked = lockRemainingSeconds(user, now);
        const unknownLocked = unknownDeviceLockRemainingSeconds(user, now);
        const sessions = (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?').get(user.id, now) as { n: number }).n;
        const codes = backupCodesStatus(user.id);
        print(`#${user.id}  ${user.username}  <${user.email}>`);
        print(`     créé le ${new Date(user.created_at).toISOString()} · mot de passe du ${new Date(user.password_changed_at).toISOString()}`);
        print(`     ${locked > 0 ? `VERROUILLÉ encore ${Math.ceil(locked / 60)} min` : 'non verrouillé'} · échecs en cours : ${user.failed_attempts} · sessions non révoquées : ${sessions} · codes de secours : ${codes.remaining}/${codes.total}`);
        if (unknownLocked > 0) print(`     connexions depuis des appareils INCONNUS bloquées encore ${Math.ceil(unknownLocked / 60)} min (appareils connus et sessions non affectés)`);
      }
      audit(null, { action: 'cli.admin.list' });
    },
  },

  unlock: {
    usage: 'unlock <utilisateur>',
    description: 'Lève le verrouillage d’un compte et remet ses compteurs d’échecs à zéro.',
    async run([identifier]) {
      const user = requireUser(identifier);
      unlockAccount(user.id);
      audit(null, { action: 'cli.account.unlock', target: `compte ${user.username}`, userId: user.id });
      print(`Compte « ${user.username} » déverrouillé.`);
      cliAlert(`Compte déverrouillé : ${user.username}`, `Le verrouillage du compte ${user.username} a été levé.`, user);
    },
  },

  'reset-password': {
    usage: 'reset-password <utilisateur>',
    description: 'Définit un nouveau mot de passe et ferme toutes les sessions du compte.',
    async run([identifier]) {
      const user = requireUser(identifier);
      print(`Nouveau mot de passe pour « ${user.username} »`);
      const password = await askNewPassword({ username: user.username, email: user.email });
      const problems = await setPassword(user, password);
      if (problems.length) throw new CliError(`Mot de passe refusé : ${problems.join(', ')}`);
      const revoked = revokeUserSessions(user.id);
      // Aucun appareil ne garde d'abonnement push après une commande de secours.
      removeAllPush(user.id);
      audit(null, { action: 'cli.password.reset', target: `compte ${user.username}`, userId: user.id, details: { revokedSessions: revoked } });
      print(`Mot de passe modifié. Sessions fermées : ${revoked}.`);
      cliAlert(`Mot de passe réinitialisé : ${user.username}`, `Le mot de passe du compte ${user.username} a été réinitialisé.`, user);
    },
  },

  'reset-2fa': {
    usage: 'reset-2fa <utilisateur>',
    description: 'Génère un nouveau secret 2FA et de nouveaux codes de secours ; ferme toutes les sessions du compte.',
    async run([identifier]) {
      const user = requireUser(identifier);
      print(`Nouvelle double authentification pour « ${user.username} »`);
      const { secret, step } = await enrollTotp(user.username);
      setTotpSecret(user.id, secret, step);
      const codes = regenerateBackupCodes(user.id);
      const revoked = revokeUserSessions(user.id);
      // Aucun appareil ne garde d'abonnement push après une commande de secours.
      removeAllPush(user.id);
      audit(null, { action: 'cli.totp.reset', target: `compte ${user.username}`, userId: user.id, details: { revokedSessions: revoked } });
      print();
      print(`2FA réinitialisée. Sessions fermées : ${revoked}.`);
      printBackupCodes(codes);
      cliAlert(`2FA réinitialisée : ${user.username}`, `Le secret 2FA et les codes de secours du compte ${user.username} ont été régénérés.`, user);
    },
  },

  'revoke-sessions': {
    usage: 'revoke-sessions <utilisateur>',
    description: 'Ferme immédiatement toutes les sessions du compte.',
    async run([identifier]) {
      const user = requireUser(identifier);
      const revoked = revokeUserSessions(user.id);
      // Aucun appareil ne garde d'abonnement push après une commande de secours.
      removeAllPush(user.id);
      audit(null, { action: 'cli.sessions.revoke', target: `compte ${user.username}`, userId: user.id, details: { revokedSessions: revoked } });
      print(`Sessions fermées pour « ${user.username} » : ${revoked}.`);
    },
  },

  'clear-ip-allowlist': {
    usage: 'clear-ip-allowlist',
    description: 'Vide la liste blanche d’IP gérée dans le panel (secours si vous vous êtes enfermé dehors). IP_ALLOWLIST du .env reste appliquée.',
    async run() {
      const previous = getPanelAllowlist();
      setPanelAllowlist([], null);
      audit(null, { action: 'cli.ip_allowlist.clear', details: { previous } });
      print(`Liste blanche du panel vidée (${previous.length} entrée(s) retirée(s)). Prise en compte par le serveur en quelques secondes.`);
      cliAlert("Liste blanche d'IP vidée", "La liste blanche d'IP gérée dans le panel a été vidée.", null);
    },
  },
};

function printHelp(): void {
  print('TalCloud Panel — CLI d’installation et de secours');
  print();
  print('Commandes :');
  for (const command of Object.values(commands)) {
    print(`  ${command.usage.padEnd(30)} ${command.description}`);
  }
}

async function main(): Promise<number> {
  const [name, ...args] = process.argv.slice(2);
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    printHelp();
    return name ? 0 : 1;
  }
  const command = commands[name];
  if (!command) {
    print(`Commande inconnue : ${name}`);
    print();
    printHelp();
    return 1;
  }
  try {
    await command.run(args);
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      print(`Erreur : ${err.message}`);
    } else {
      // Jamais de trace contenant une saisie : seul le message est affiché.
      print(`Erreur : ${err instanceof Error ? err.message : 'erreur inattendue'}`);
    }
    return 1;
  }
}

const exitCode = await main();
prompterRef.current?.close();
// Les alertes (mail / Discord) partent en arrière-plan : on attend leur envoi avant de quitter.
await Promise.race([flushAlerts(), new Promise((resolve) => setTimeout(resolve, 15_000))]);
db.close();
process.exit(exitCode);
