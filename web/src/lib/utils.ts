import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Les URL venant d'une API (adminUrl, panelUrl…) sont des données non fiables :
 * elles ne sont utilisées comme lien que si elles sont en http(s).
 */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : (parts[0]?.[1] ?? '');
  return (first + last).toUpperCase();
}

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Lecture / écriture tolérantes des deux seules préférences d'interface stockées localement (thème, sidebar). */
export function readPreference(key: 'tc-theme' | 'tc-sidebar'): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writePreference(key: 'tc-theme' | 'tc-sidebar', value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* stockage indisponible : la préférence ne sera pas mémorisée */
  }
}
