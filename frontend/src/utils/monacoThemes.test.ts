import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference: vi.fn(),
}));

import { clearLocalStorageCache } from '@/lib/safeStorage';
import {
  previewColorTheme,
  COLOR_THEME_CHANGED_EVENT,
} from '@/lib/theme/colorThemeStore';

import {
  defineColorThemeMonacoThemes,
  MONACO_THEME_DARK,
  MONACO_THEME_LIGHT,
} from './monacoThemes';

describe('color theme Monaco themes', () => {
  beforeEach(() => {
    localStorage.clear();
    clearLocalStorageCache();
    previewColorTheme(null);
  });

  it('paints the editor on the code canvas with accent selection', () => {
    const defineTheme = vi.fn();

    defineColorThemeMonacoThemes({ editor: { defineTheme } });

    expect(defineTheme).toHaveBeenCalledWith(
      MONACO_THEME_LIGHT,
      expect.objectContaining({
        base: 'vs',
        colors: expect.objectContaining({
          'editor.background': '#fafafa',
          'editor.selectionBackground': '#1b1b1b33',
        }),
      })
    );
    expect(defineTheme).toHaveBeenCalledWith(
      MONACO_THEME_DARK,
      expect.objectContaining({
        base: 'vs-dark',
        colors: expect.objectContaining({
          'editor.background': '#0f141a',
          'editorGutter.background': '#0f141a',
          'editor.selectionBackground': '#e7ebef4d',
        }),
        rules: expect.arrayContaining([
          { token: 'keyword', foreground: 'ffab57' },
        ]),
      })
    );
  });

  it('redefines and reapplies the themes when the color theme changes', () => {
    const defineTheme = vi.fn();
    const setTheme = vi.fn();
    defineColorThemeMonacoThemes({ editor: { defineTheme, setTheme } });
    defineTheme.mockClear();

    previewColorTheme({
      id: 'mirage',
      label: 'Mirage',
      scheme: 'dark',
      colors: { background: '#1f2430', foreground: '#cccac2' },
    });
    window.dispatchEvent(new CustomEvent(COLOR_THEME_CHANGED_EVENT));

    expect(defineTheme).toHaveBeenCalledWith(
      MONACO_THEME_DARK,
      expect.objectContaining({
        colors: expect.objectContaining({ 'editor.background': '#1f2430' }),
      })
    );
    expect(setTheme).toHaveBeenCalledWith(MONACO_THEME_LIGHT);
  });
});
