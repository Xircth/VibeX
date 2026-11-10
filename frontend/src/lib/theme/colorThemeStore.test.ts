import type { ThemeContribution, ThemeDefinition } from '@vibex/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const persistFrontendPreference = vi.hoisted(() => vi.fn());

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference,
}));

import { clearLocalStorageCache } from '@/lib/safeStorage';

import {
  COLOR_THEME_KEYS,
  builtinThemeKey,
  deleteUserColorTheme,
  exportColorTheme,
  getActiveColorTheme,
  getColorThemeSnapshot,
  initColorThemes,
  parseColorThemeFile,
  pluginThemeKey,
  previewColorTheme,
  saveUserColorTheme,
  selectColorTheme,
  setPluginColorThemes,
  uniqueUserThemeId,
  userThemeKey,
} from './colorThemeStore';

const mirage: ThemeDefinition = {
  id: 'ayu-mirage',
  label: 'Ayu Mirage',
  scheme: 'dark',
  colors: { background: '#1f2430', foreground: '#cccac2' },
};

const pluginMirage: ThemeContribution = {
  ...mirage,
  pluginId: 'community.ayu-theme',
};

function themeStylesheet(): string {
  return (
    document.head.querySelector('style[data-vibex-color-theme]')?.textContent ??
    ''
  );
}

describe('colorThemeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    clearLocalStorageCache();
    persistFrontendPreference.mockReset();
    setPluginColorThemes([], null);
    previewColorTheme(null);
  });

  afterEach(() => {
    localStorage.clear();
    clearLocalStorageCache();
  });

  it('paints nothing extra for the built-in themes', () => {
    initColorThemes();
    const snapshot = getColorThemeSnapshot();
    expect(snapshot.active.light.key).toBe(builtinThemeKey('light'));
    expect(snapshot.active.dark.key).toBe(builtinThemeKey('dark'));
    expect(themeStylesheet()).toBe('');
  });

  it('applies a selected plugin theme and persists the pick', () => {
    setPluginColorThemes([pluginMirage], new Set(['community.ayu-theme']));
    const key = pluginThemeKey('community.ayu-theme', 'ayu-mirage');
    selectColorTheme('dark', key);

    expect(getColorThemeSnapshot().active.dark.key).toBe(key);
    expect(persistFrontendPreference).toHaveBeenCalledWith(
      COLOR_THEME_KEYS.dark,
      key
    );
    expect(themeStylesheet()).toContain('--surface-shell: #1f2430;');
  });

  it('keeps a cached plugin theme until the plugin is known to be gone', () => {
    setPluginColorThemes([pluginMirage], new Set(['community.ayu-theme']));
    selectColorTheme(
      'dark',
      pluginThemeKey('community.ayu-theme', 'ayu-mirage')
    );

    setPluginColorThemes([], null);
    expect(getActiveColorTheme('dark').id).toBe('ayu-mirage');

    setPluginColorThemes([], new Set());
    expect(getActiveColorTheme('dark').id).toBe('dark');
    expect(localStorage.getItem(COLOR_THEME_KEYS.dark)).toBe(
      pluginThemeKey('community.ayu-theme', 'ayu-mirage')
    );
  });

  it('saves, selects, previews, and deletes user themes', () => {
    const key = saveUserColorTheme({ ...mirage, id: 'mine' });
    selectColorTheme('dark', key);
    expect(getActiveColorTheme('dark').id).toBe('mine');
    expect(uniqueUserThemeId('Mine')).toBe('mine-2');

    previewColorTheme({
      ...mirage,
      id: 'draft',
      colors: { ...mirage.colors, background: '#000000' },
    });
    expect(themeStylesheet()).toContain('--surface-shell: #000000;');
    previewColorTheme(null);
    expect(themeStylesheet()).toContain('--surface-shell: #1f2430;');

    deleteUserColorTheme('mine');
    expect(localStorage.getItem(COLOR_THEME_KEYS.dark)).toBe(
      builtinThemeKey('dark')
    );
    expect(
      getColorThemeSnapshot().themes.map((entry) => entry.key)
    ).not.toContain(userThemeKey('mine'));
  });

  it('round-trips the plugin themes[] entry format', () => {
    const file = exportColorTheme(mirage);
    expect(parseColorThemeFile(file)).toEqual({ themes: [mirage] });
    expect(parseColorThemeFile(`[${file}]`)).toEqual({ themes: [mirage] });
    expect(parseColorThemeFile('{')).toEqual({
      issues: [{ path: 'file', message: 'is not valid JSON' }],
    });
    expect(
      parseColorThemeFile(JSON.stringify([{ ...mirage, scheme: 'dim' }]))
    ).toEqual({
      issues: [{ path: 'themes[0].scheme', message: 'must be light or dark' }],
    });
  });
});
