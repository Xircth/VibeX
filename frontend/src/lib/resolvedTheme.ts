import { readLocalStorage, writeLocalStorage } from '@/lib/safeStorage';

export type CachedResolvedTheme = 'light' | 'dark';

export const RESOLVED_THEME_KEY = 'vibex:resolved-theme';

export function readCachedResolvedTheme(): CachedResolvedTheme | null {
  const value = readLocalStorage(RESOLVED_THEME_KEY);
  return value === 'dark' || value === 'light' ? value : null;
}

export function persistResolvedTheme(theme: CachedResolvedTheme): void {
  writeLocalStorage(RESOLVED_THEME_KEY, theme);
}

export function applyResolvedThemeClass(theme: CachedResolvedTheme): void {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
}

export function initResolvedTheme(): void {
  const cached = readCachedResolvedTheme();
  if (cached) {
    applyResolvedThemeClass(cached);
  }
}
