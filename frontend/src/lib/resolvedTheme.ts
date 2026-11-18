import { getAppRouteMode } from '@/appRouteMode';
import { applyAccentColor } from '@/lib/uiAccent';
import { readLocalStorage, writeLocalStorage } from '@/lib/safeStorage';

export type CachedResolvedTheme = 'light' | 'dark';

export const RESOLVED_THEME_KEY = 'dimo:resolved-theme';

export const PAGE_CANVAS: Record<CachedResolvedTheme, string> = {
  light: '#ffffff',
  dark: '#1b1b1b',
};

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
  if (getAppRouteMode(window.location.pathname) !== 'desktop-toast') {
    const canvas = PAGE_CANVAS[theme];
    root.style.backgroundColor = canvas;
    root.style.colorScheme = theme === 'dark' ? 'only dark' : 'only light';
    document.body.style.backgroundColor = canvas;
  }
  applyAccentColor(theme);
}

export function initResolvedTheme(): void {
  const cached = readCachedResolvedTheme();
  if (cached) {
    applyResolvedThemeClass(cached);
  }
}
