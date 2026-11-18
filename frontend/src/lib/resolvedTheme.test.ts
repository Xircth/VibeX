import { afterEach, describe, expect, it } from 'vitest';

import { clearLocalStorageCache } from './safeStorage';
import {
  applyResolvedThemeClass,
  persistResolvedTheme,
  readCachedResolvedTheme,
  RESOLVED_THEME_KEY,
} from './resolvedTheme';
import { ACCENT_COLOR_KEY } from './uiAccent';

describe('resolvedTheme', () => {
  afterEach(() => {
    window.localStorage.clear();
    clearLocalStorageCache();
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
    window.history.replaceState({}, '', '/');
  });

  it('persists and reads the last resolved theme', () => {
    persistResolvedTheme('dark');
    expect(window.localStorage.getItem(RESOLVED_THEME_KEY)).toBe('dark');
    expect(readCachedResolvedTheme()).toBe('dark');
  });

  it('applies the class without leaving the previous theme behind', () => {
    applyResolvedThemeClass('light');
    applyResolvedThemeClass('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.documentElement.style.backgroundColor).toBe(
      'var(--surface-shell)'
    );
    expect(document.documentElement.style.colorScheme).toBe('only dark');
    expect(document.body.style.backgroundColor).toBe('var(--surface-shell)');
  });

  it('leaves the desktop toast shell transparent', () => {
    window.history.replaceState({}, '', '/desktop-toast');
    applyResolvedThemeClass('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.backgroundColor).toBe('');
    expect(document.body.style.backgroundColor).toBe('');
  });

  it('leaves the accent to the active theme without an override', () => {
    applyResolvedThemeClass('dark');
    expect(
      document.documentElement.style.getPropertyValue('--accent-hsl')
    ).toBe('');
  });

  it('reapplies the theme-resolved accent override when the class changes', () => {
    window.localStorage.setItem(ACCENT_COLOR_KEY, '#1b1b1b');
    applyResolvedThemeClass('light');
    expect(
      document.documentElement.style.getPropertyValue('--accent-hsl')
    ).toBe('0 0% 10.59%');

    applyResolvedThemeClass('dark');
    expect(
      document.documentElement.style.getPropertyValue('--accent-hsl')
    ).toBe('210 20% 92.16%');
  });
});
