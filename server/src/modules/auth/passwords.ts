import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id, au-delà du minimum OWASP (m = 19 MiB, t = 2, p = 1).
 * `algorithm: 2` = Argon2id (l'enum du paquet est un `const enum` ambiant, inutilisable avec isolatedModules).
 */
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 65_536, timeCost: 3, parallelism: 1, outputLen: 32 } as const;

export const PASSWORD_MIN_LENGTH = 14;
export const PASSWORD_MAX_LENGTH = 200;

/** Bases de mots de passe courants : refusées seules ou simplement décorées de chiffres / symboles. */
const COMMON = new Set([
  'password', 'passwords', 'motdepasse', 'motdepasses', 'azerty', 'azertyuiop', 'qwerty', 'qwertyuiop', 'qwertz', 'admin',
  'administrator', 'administrateur', 'welcome', 'bienvenue', 'letmein', 'iloveyou', 'jetaime', 'monkey', 'dragon', 'master',
  'soleil', 'doudou', 'loulou', 'chocolat', 'football', 'baseball', 'superman', 'batman', 'starwars', 'pokemon', 'minecraft',
  'changeme', 'changezmoi', 'secret', 'trustno', 'passw', 'passwd', 'pass', 'root', 'toor', 'test', 'demo', 'login', 'talcloud',
  'talcloudpanel', 'hebergeur', 'hosting', 'serveur', 'server', 'proxmox', 'pterodactyl', 'whmcs', 'abc', 'abcdef', 'abcdefgh',
  'qazwsx', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', 'azertyqwerty', 'passwordpassword', 'adminadmin', 'sunshine', 'princess',
]);

/** Bases si répandues que leur simple présence (même en « leet ») disqualifie le mot de passe. */
const VERY_COMMON = ['password', 'motdepasse', 'azerty', 'qwerty', 'qwertz', 'letmein', 'iloveyou', 'welcome', 'bienvenue', 'changeme', 'talcloud', 'administrat'];

export interface PasswordContext {
  username?: string;
  email?: string;
}

/** Retourne la liste des problèmes (vide = mot de passe accepté). */
export function passwordProblems(password: string, context: PasswordContext = {}): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`au moins ${PASSWORD_MIN_LENGTH} caractères`);
  if (password.length > PASSWORD_MAX_LENGTH) problems.push(`au plus ${PASSWORD_MAX_LENGTH} caractères`);
  if (!/\p{Ll}/u.test(password)) problems.push('au moins une minuscule');
  if (!/\p{Lu}/u.test(password)) problems.push('au moins une majuscule');
  if (!/\p{Nd}/u.test(password)) problems.push('au moins un chiffre');
  if (!/[^\p{L}\p{Nd}\s]/u.test(password)) problems.push('au moins un symbole');
  if (new Set(password).size < 8) problems.push('au moins 8 caractères différents');

  const lower = password.toLowerCase();
  const username = context.username?.trim().toLowerCase();
  if (username && username.length >= 3 && lower.includes(username)) problems.push("ne doit pas contenir le nom d'utilisateur");
  const email = context.email?.trim().toLowerCase();
  if (email) {
    const [local = '', domain = ''] = email.split('@');
    const parts = [email, local, ...local.split(/[._+-]/), domain.split('.')[0] ?? ''].filter((part) => part.length >= 4);
    if (parts.some((part) => lower.includes(part))) problems.push("ne doit pas contenir l'adresse e-mail");
  }

  // 1) Base courante simplement décorée de chiffres / symboles : « Admin-2024-!!!!! » → « admin ».
  const lettersOnly = lower.replace(/[^a-z]/g, '');
  // 2) Base très courante présente telle quelle ou en « leet » : « P@ssw0rd123456!! » → « password… ».
  const deLeet = lower.replace(/[@4]/g, 'a').replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[$5]/g, 's').replace(/7/g, 't');
  if (COMMON.has(lettersOnly) || VERY_COMMON.some((base) => lower.includes(base) || deLeet.includes(base))) {
    problems.push('trop courant ou trop prévisible');
  }

  return problems;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** Vérifie un mot de passe. Ne lève jamais d'exception (hash illisible = refus). */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

const DUMMY_PASSWORD = 'factice-0e9d1c7b-ne-correspond-a-aucun-compte';
let dummyHash: Promise<string> | null = null;

/**
 * Vérification factice (mêmes paramètres Argon2id) quand l'identifiant est inconnu, pour que le temps de
 * réponse ne permette pas de distinguer « compte inconnu » de « mauvais mot de passe ».
 */
export async function verifyDummyPassword(password: string): Promise<false> {
  dummyHash ??= hashPassword(DUMMY_PASSWORD);
  try {
    await verifyPassword(await dummyHash, password);
  } catch {
    dummyHash = null;
  }
  return false;
}

/** À appeler au démarrage pour que la première tentative ne paie pas le calcul du hash factice. */
export function warmUpPasswordHasher(): void {
  dummyHash ??= hashPassword(DUMMY_PASSWORD);
  dummyHash.catch(() => {
    dummyHash = null;
  });
}
