import { describe, expect, it, vi } from 'vitest';

import {
  defineAyuMonacoThemes,
  MONACO_THEME_AYU_DARK,
  MONACO_THEME_AYU_LIGHT,
} from './monacoThemes';

describe('Ayu Monaco themes', () => {
  it('paints the dark editor on Mirage with Pearl Ink selection', () => {
    const defineTheme = vi.fn();

    defineAyuMonacoThemes({ editor: { defineTheme } });

    expect(defineTheme).toHaveBeenCalledWith(
      MONACO_THEME_AYU_LIGHT,
      expect.objectContaining({
        colors: expect.objectContaining({
          'editor.background': '#FAFAFA',
          'editor.selectionBackground': '#17171733',
        }),
      })
    );
    expect(defineTheme).toHaveBeenCalledWith(
      MONACO_THEME_AYU_DARK,
      expect.objectContaining({
        colors: expect.objectContaining({
          'editor.background': '#1F2430',
          'editorGutter.background': '#1F2430',
          'editor.selectionBackground': '#E7EBEF4D',
        }),
      })
    );
  });
});
