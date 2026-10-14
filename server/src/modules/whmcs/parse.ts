/**
 * Lecture tolérante des réponses de l'API WHMCS.
 *
 * WHMCS (PHP) renvoie des formes irrégulières :
 *  - une liste vide devient une chaîne vide (`"clients": ""`), ou la clé disparaît ;
 *  - un résultat unique peut être un objet au lieu d'un tableau (`"client": { … }`) ;
 *  - un tableau PHP à clés non consécutives devient un objet à clés numériques ;
 *  - les nombres sont des chaînes (`"12.50"`), les dates nulles valent « 0000-00-00 » ;
 *  - certains libellés sont encodés en entités HTML.
 */

export type Raw = Record<string, unknown>;

export const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

function toArray(value: unknown): Raw[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  const keys = Object.keys(value);
  if (keys.length === 0) return [];
  // Tableau PHP sérialisé en objet { "0": {…}, "2": {…} }.
  if (keys.every((key) => /^\d+$/.test(key))) return Object.values(value).filter(isRecord);
  return [value];
}

/** Extrait `body[container][item]` quelle que soit sa forme. Ex. extractList(body, 'clients', 'client'). */
export function extractList(body: Raw, container: string, item: string): Raw[] {
  const outer = body[container];
  if (Array.isArray(outer)) return outer.filter(isRecord);
  if (!isRecord(outer)) return [];
  if (item in outer) return toArray(outer[item]);
  return Object.keys(outer).every((key) => /^\d+$/.test(key)) ? toArray(outer) : [];
}

/** Nombre fini, ou null si la valeur n'en est pas un. */
export function numOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export const num = (value: unknown): number => numOrNull(value) ?? 0;

/** Entier positif ou nul (identifiants, compteurs). */
export function int(value: unknown): number {
  const parsed = numOrNull(value);
  return parsed !== null && parsed > 0 ? Math.trunc(parsed) : 0;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Décode les entités HTML courantes. Le résultat est du TEXTE destiné à du JSON : il n'est jamais injecté
 * dans du HTML côté serveur, et le frontend l'affiche comme texte (échappé par React).
 */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,6});/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Chaîne nettoyée, ou null si vide / absente. */
export function str(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const text = decodeEntities(value).trim();
  return text === '' ? null : text;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

function parts(value: unknown): RegExpExecArray | null {
  if (typeof value !== 'string') return null;
  const match = DATE_RE.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return null; // dont « 0000-00-00 »
  return match;
}

/** Date seule « YYYY-MM-DD » (ISO 8601), telle que WHMCS la connaît, ou null. */
export function dateOnly(value: unknown): string | null {
  const match = parts(value);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/**
 * Date WHMCS → ISO 8601. WHMCS renvoie des dates « naïves », dans SON fuseau :
 *  - date seule : renvoyée telle quelle (« YYYY-MM-DD »), sans conversion, pour ne jamais décaler d'un jour ;
 *  - date et heure : interprétées dans le fuseau du serveur du panel (variable TZ, à aligner sur celui de WHMCS).
 */
export function dateTimeIso(value: unknown): string | null {
  const match = parts(value);
  if (!match) return null;
  if (match[4] === undefined) return `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Mois « YYYY-MM » d'une date WHMCS : lu directement dans la chaîne, donc dans le fuseau de WHMCS.
 * Aucune conversion de fuseau n'est faite : une transaction du 31 à 23:59 reste dans son mois, comme dans les
 * rapports de WHMCS.
 */
export function monthOf(value: unknown): string | null {
  const match = parts(value);
  return match ? `${match[1]}-${match[2]}` : null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Mois en cours « YYYY-MM » dans le fuseau du serveur du panel. */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

/** Date du jour « YYYY-MM-DD » dans le fuseau du serveur du panel. */
export function today(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addMonths(month: string, delta: number): string {
  const index = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  return `${Math.floor(index / 12)}-${pad((((index % 12) + 12) % 12) + 1)}`;
}

/** `count` mois consécutifs se terminant à `end` inclus, du plus ancien au plus récent. */
export function monthsEndingAt(end: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addMonths(end, i - (count - 1)));
}

/** Arrondi monétaire à 2 décimales — à n'appliquer qu'en sortie, jamais sur les valeurs intermédiaires. */
export function round2(value: number): number {
  const rounded = Math.round((value + Math.sign(value) * Number.EPSILON) * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}
