import { useCallback, useSyncExternalStore } from 'react';
import { readPreference, writePreference } from '@/lib/utils';

export type Theme = 'dark' | 'light';

const listeners = new Set<() => void>();

function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  // Coupe les transitions le temps de la bascule : pas de fondu désordonné entre les deux palettes.
  const style = document.createElement('style');
  style.textContent = '*,*::before,*::after{transition:none!important}';
  document.head.appendChild(style);
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0c0c0e' : '#fafafa');
  void window.getComputedStyle(root).opacity;
  requestAnimationFrame(() => style.remove());
  writePreference('tc-theme', theme);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Thème sombre par défaut ; la préférence est mémorisée (seule donnée d'interface stockée avec l'état de la sidebar). */
export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void; toggleTheme: () => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => 'dark' as Theme);
  const setTheme = useCallback((next: Theme) => applyTheme(next), []);
  const toggleTheme = useCallback(() => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'), []);
  return { theme, setTheme, toggleTheme };
}

export const storedTheme = (): Theme => (readPreference('tc-theme') === 'light' ? 'light' : 'dark');
