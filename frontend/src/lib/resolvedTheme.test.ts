import { afterEach, describe, expect, it } from 'vitest';

import { clearLocalStorageCache } from './safeStorage';
import {
  applyResolvedThemeClass,
  persistResolvedTheme,
  readCachedResolvedTheme,
  RESOLVED_THEME_KEY,
} from './resolvedTheme';

describe('resolvedTheme', () => {
  afterEach(() => {
    window.localStorage.clear();
    clearLocalStorageCache();
    document.documentElement.classList.remove('light', 'dark');
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
  });
});
