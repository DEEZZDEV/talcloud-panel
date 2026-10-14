import { useCallback, useSyncExternalStore } from 'react';
import { readPreference, writePreference } from '@/lib/utils';

/** Thème réellement affiché. */
export type Theme = 'dark' | 'light';
/** Préférence du compte (`system` suit le réglage du système d'exploitation). */
export type ThemePreference = 'dark' | 'light' | 'system';

const listeners = new Set<() => void>();
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

const isPreference = (value: unknown): value is ThemePreference => value === 'dark' || value === 'light' || value === 'system';

/** Préférence courante : celle du compte une fois synchronisée, sinon le cache local (localStorage). */
let preference: ThemePreference = isPreference(readPreference('tc-theme')) ? (readPreference('tc-theme') as ThemePreference) : 'dark';

const resolve = (value: ThemePreference): Theme => (value === 'system' ? (media?.matches ? 'light' : 'dark') : value);

function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function paint(theme: Theme): void {
  const root = document.documentElement;
  if (currentTheme() === theme && root.style.colorScheme === theme) return;
  // Coupe les transitions le temps de la bascule : pas de fondu désordonné entre les deux palettes.
  const style = document.createElement('style');
  style.textContent = '*,*::before,*::after{transition:none!important}';
  document.head.appendChild(style);
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0c0c0e' : '#fafafa');
  void window.getComputedStyle(root).opacity;
  requestAnimationFrame(() => style.remove());
}

/** Applique une préférence de thème et la garde en cache local (affichage initial sans flash au prochain chargement). */
export function applyThemePreference(next: ThemePreference): void {
  preference = next;
  writePreference('tc-theme', next);
  paint(resolve(next));
  listeners.forEach((listener) => listener());
}

// Préférence « system » : suit les changements du système en direct.
media?.addEventListener('change', () => {
  if (preference !== 'system') return;
  paint(resolve('system'));
  listeners.forEach((listener) => listener());
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = (): string => `${preference}:${currentTheme()}`;

/**
 * Thème affiché et préférence courante. L'enregistrement côté serveur (préférence du compte) est fait par
 * `useThemeSetter` (features/preferences) ; ce hook ne touche qu'à l'affichage et au cache local.
 */
export function useTheme(): { theme: Theme; preference: ThemePreference } {
  const value = useSyncExternalStore(subscribe, snapshot, () => 'dark:dark');
  const [pref, theme] = value.split(':') as [ThemePreference, Theme];
  return { theme, preference: pref };
}

/** Bascule purement locale (sans compte : page de connexion). */
export function useLocalThemeToggle(): () => void {
  return useCallback(() => applyThemePreference(currentTheme() === 'dark' ? 'light' : 'dark'), []);
}
