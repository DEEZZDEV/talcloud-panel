import { format, formatDistanceToNowStrict, isToday, isValid, isYesterday, parseISO } from 'date-fns';
import { fr } from 'date-fns/locale';

const LOCALE = 'fr-FR';
const currencyFormatters = new Map<string, Intl.NumberFormat>();
const numberFormatter = new Intl.NumberFormat(LOCALE);
const compactFormatter = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });

function currencyFormatter(currency: string, fractionDigits: number): Intl.NumberFormat | null {
  const key = `${currency}:${fractionDigits}`;
  const cached = currencyFormatters.get(key);
  if (cached) return cached;
  try {
    const created = new Intl.NumberFormat(LOCALE, { style: 'currency', currency, minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
    currencyFormatters.set(key, created);
    return created;
  } catch {
    // Code devise inattendu renvoyé par l'API : on affiche le nombre suivi du code tel quel.
    return null;
  }
}

/** Montant au format fr-FR dans la devise fournie par l'API (ex. « 1 234,50 € »). */
export function formatMoney(amount: number | null | undefined, currency: string | null | undefined, options: { decimals?: boolean } = {}): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  const digits = options.decimals === false ? 0 : 2;
  const code = (currency ?? '').trim().toUpperCase();
  const formatter = /^[A-Z]{3}$/.test(code) ? currencyFormatter(code, digits) : null;
  if (formatter) return formatter.format(amount);
  const plain = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
  return code ? `${plain} ${code}` : plain;
}

/** Montant compact pour les axes de graphiques (ex. « 12,5 k € »). */
export function formatMoneyCompact(amount: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  try {
    return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: code, notation: 'compact', maximumFractionDigits: 1 }).format(amount);
  } catch {
    return compactFormatter.format(amount);
  }
}

export const formatNumber = (value: number | null | undefined): string => (value === null || value === undefined || !Number.isFinite(value) ? '—' : numberFormatter.format(value));
export const formatCompact = (value: number): string => compactFormatter.format(value);

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)} %`;
}

/** Variation signée (ex. « +12,4 % »). */
export function formatDelta(value: number): string {
  const formatted = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 1, signDisplay: 'exceptZero' }).format(value);
  return `${formatted} %`;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'string' ? parseISO(value) : new Date(value);
  return isValid(date) ? date : null;
}

export function formatDate(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? format(date, 'd MMM yyyy', { locale: fr }) : '—';
}

export function formatDateTime(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? format(date, "d MMM yyyy 'à' HH:mm", { locale: fr }) : '—';
}

export function formatTime(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? format(date, 'HH:mm', { locale: fr }) : '—';
}

/** Date courte adaptée aux listes : heure si aujourd'hui, « hier », sinon jour et mois. */
export function formatSmartDate(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  if (isToday(date)) return format(date, 'HH:mm', { locale: fr });
  if (isYesterday(date)) return 'Hier';
  if (date.getFullYear() === new Date().getFullYear()) return format(date, 'd MMM', { locale: fr });
  return format(date, 'dd/MM/yyyy', { locale: fr });
}

export function formatRelative(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  if (Math.abs(Date.now() - date.getTime()) < 45_000) return "à l'instant";
  return formatDistanceToNowStrict(date, { locale: fr, addSuffix: true });
}

/** « 2026-03 » → « mars 2026 » (ou « mars » / « mars 26 »). */
export function formatMonth(month: string | null | undefined, style: 'long' | 'short' | 'axis' = 'long'): string {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return month ?? '—';
  const date = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
  if (!isValid(date)) return month;
  if (style === 'axis') return format(date, 'MMM', { locale: fr }).replace('.', '');
  if (style === 'short') return format(date, 'MMM yy', { locale: fr });
  return format(date, 'MMMM yyyy', { locale: fr });
}

export const currentMonth = (): string => format(new Date(), 'yyyy-MM');

const BYTE_UNITS = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'];
export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 o';
  const exponent = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  const formatted = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: value >= 100 || exponent === 0 ? 0 : digits }).format(value);
  return `${formatted} ${BYTE_UNITS[exponent]}`;
}

/** Durée lisible : « 12 j 4 h », « 3 h 12 min », « 45 s ». */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return '—';
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} j ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} s`;
}

/** Compte à rebours « 04:59 ». */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames([LOCALE], { type: 'region' });
  } catch {
    return null;
  }
})();

/** Code pays ISO → nom français (« FR » → « France »). */
export function formatCountry(code: string | null | undefined): string {
  if (!code) return 'Pays inconnu';
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return code;
  try {
    return regionNames?.of(upper) ?? upper;
  } catch {
    return upper;
  }
}

export const plural = (count: number, singular: string, pluralForm = `${singular}s`): string => `${formatNumber(count)} ${count > 1 ? pluralForm : singular}`;
