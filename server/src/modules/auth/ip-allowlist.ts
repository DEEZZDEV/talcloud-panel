import ipaddr from 'ipaddr.js';
import { config } from '../../config.js';
import { getSettings, setSettings } from '../../core/settings.js';

type Address = ReturnType<typeof ipaddr.parse>;
type Range = [Address, number];

const SETTINGS_NAMESPACE = 'security';
export const MAX_ALLOWLIST_ENTRIES = 100;

interface SecuritySettings {
  ipAllowlist?: string[];
}

/**
 * IPv4 : uniquement quatre nombres décimaux sans zéro initial. Les notations héritées acceptées par la
 * bibliothèque (« 010.0.0.1 » lu en octal = 8.0.0.1, « 1.2.3 », « 0x7f.1 ») sont ambiguës, donc refusées —
 * y compris dans la partie IPv4 d'une adresse mappée (« ::ffff:1.2.3.4 »).
 */
function hasStrictIpv4Part(address: string): boolean {
  if (!address.includes('.')) return true;
  return ipaddr.IPv4.isValidFourPartDecimal(address.slice(address.lastIndexOf(':') + 1));
}

/** Adresse normalisée : une IPv4 mappée en IPv6 (::ffff:1.2.3.4) devient l'IPv4. null si invalide. */
export function parseIp(value: string): Address | null {
  const raw = value.trim();
  if (!ipaddr.isValid(raw)) return null;
  if (!hasStrictIpv4Part(raw)) return null;
  try {
    return ipaddr.process(raw);
  } catch {
    return null;
  }
}

/** Forme canonique d'une IP (IPv4 mappée → IPv4). Retourne l'entrée telle quelle si elle est illisible. */
export function normalizeIp(value: string): string {
  return parseIp(value)?.toString() ?? value;
}

/**
 * Clé de comptage par appelant : l'IPv4 exacte, ou le préfixe /64 pour une IPv6 (un abonné IPv6 dispose
 * d'un /64 entier : compter par adresse permettrait de contourner les blocages en changeant d'adresse).
 */
export function ipRateKey(ip: string): string {
  const addr = parseIp(ip);
  if (!addr) return ip;
  if (addr.kind() === 'ipv4') return addr.toString();
  try {
    return `${ipaddr.IPv6.networkAddressFromCIDR(`${addr.toString()}/64`).toString()}/64`;
  } catch {
    return addr.toString();
  }
}

function parseEntry(entry: string): Range | null {
  const raw = entry.trim();
  if (!raw || raw.length > 64) return null;
  try {
    if (!raw.includes('/')) {
      const addr = parseIp(raw);
      return addr ? [addr, addr.kind() === 'ipv4' ? 32 : 128] : null;
    }
    if (!ipaddr.isValidCIDR(raw)) return null;
    if (!hasStrictIpv4Part(raw.slice(0, raw.lastIndexOf('/')))) return null;
    let [addr, bits] = ipaddr.parseCIDR(raw);
    if (addr.kind() === 'ipv6') {
      const v6 = addr as ipaddr.IPv6;
      if (v6.isIPv4MappedAddress()) {
        if (bits < 96) return null;
        addr = v6.toIPv4Address();
        bits -= 96;
      }
    }
    // Un préfixe /0 autoriserait tout Internet : ce n'est pas une liste blanche.
    if (bits < 1) return null;
    return [addr, bits];
  } catch {
    return null;
  }
}

/** Forme canonique d'une entrée (IP ou CIDR), ou null si elle est invalide. */
export function normalizeAllowlistEntry(entry: string): string | null {
  const range = parseEntry(entry);
  if (!range) return null;
  const [addr, bits] = range;
  const full = addr.kind() === 'ipv4' ? 32 : 128;
  return bits === full ? addr.toString() : `${addr.toString()}/${bits}`;
}

function compile(entries: readonly string[]): Range[] {
  const ranges: Range[] = [];
  for (const entry of entries) {
    const range = parseEntry(entry);
    if (range) ranges.push(range);
  }
  return ranges;
}

function matches(ip: string, ranges: readonly Range[]): boolean {
  const addr = parseIp(ip);
  if (!addr) return false;
  return ranges.some(([range, bits]) => range.kind() === addr.kind() && addr.match(range, bits));
}

/** Vrai si `ip` appartient à l'une des entrées. Une liste vide ne correspond à rien. */
export function ipMatchesEntries(ip: string, entries: readonly string[]): boolean {
  return matches(ip, compile(entries));
}

// Entrées du .env : une entrée invalide arrête le démarrage (jamais d'ouverture silencieuse du filtrage).
const invalidEnv = config.ipAllowlist.filter((entry) => !normalizeAllowlistEntry(entry));
if (invalidEnv.length) throw new Error(`Configuration invalide (.env) :\n  - IP_ALLOWLIST contient des entrées invalides : ${invalidEnv.join(', ')}`);

export const envAllowlist: readonly string[] = config.ipAllowlist.map((entry) => normalizeAllowlistEntry(entry) as string);
const envRanges = compile(envAllowlist);

// La liste du panel est relue au plus toutes les 5 s : une modification faite par la CLI est prise en compte
// sans redémarrage, sans déchiffrer les réglages à chaque requête.
const CACHE_MS = 5000;
let cache: { at: number; entries: string[]; ranges: Range[] } | null = null;

function panel(): { entries: string[]; ranges: Range[] } {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS && now >= cache.at) return cache;
  const stored = getSettings<SecuritySettings>(SETTINGS_NAMESPACE);
  const entries = Array.isArray(stored?.ipAllowlist) ? stored.ipAllowlist.filter((entry): entry is string => typeof entry === 'string') : [];
  cache = { at: now, entries, ranges: compile(entries) };
  return cache;
}

export const getPanelAllowlist = (): string[] => [...panel().entries];

export function setPanelAllowlist(entries: string[], userId: number | null): void {
  const current = getSettings<SecuritySettings>(SETTINGS_NAMESPACE) ?? {};
  setSettings(SETTINGS_NAMESPACE, { ...current, ipAllowlist: entries }, userId);
  cache = null;
}

/** Filtrage actif dès que l'union (variable IP_ALLOWLIST + liste du panel) est non vide. */
export function isIpAllowed(ip: string): boolean {
  const { ranges } = panel();
  if (envRanges.length === 0 && ranges.length === 0) return true;
  return matches(ip, envRanges) || matches(ip, ranges);
}

/** Simule l'effet d'une nouvelle liste du panel sur une IP (contrôle anti-enfermement). */
export function wouldAllow(ip: string, panelEntries: readonly string[]): boolean {
  const ranges = compile(panelEntries);
  if (envRanges.length === 0 && ranges.length === 0) return true;
  return matches(ip, envRanges) || matches(ip, ranges);
}
