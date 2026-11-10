import type { ThemeScheme } from '@vibex/plugin-sdk';

import { mixHexColors, withAlpha } from '@/lib/theme/colorMath';
import { resolveThemeColors } from '@/lib/theme/compileTheme';
import {
  COLOR_THEME_CHANGED_EVENT,
  getActiveColorTheme,
} from '@/lib/theme/colorThemeStore';
import {
  ACCENT_COLOR_CHANGED_EVENT,
  getAccentColor,
  readDocumentTheme,
} from '@/lib/uiAccent';

export const MONACO_THEME_LIGHT = 'vibe-ayu-light';
export const MONACO_THEME_DARK = 'vibe-ayu-dark';

type MonacoThemeDefiner = {
  editor: {
    defineTheme: (
      name: string,
      data: {
        base: 'vs' | 'vs-dark';
        inherit: boolean;
        rules: Array<{
          token: string;
          foreground?: string;
          fontStyle?: string;
        }>;
        colors: Record<string, string>;
      }
    ) => void;
    setTheme?: (name: string) => void;
  };
};

const THEME_NAMES: Readonly<Record<ThemeScheme, string>> = {
  light: MONACO_THEME_LIGHT,
  dark: MONACO_THEME_DARK,
};

const bare = (hex: string) => hex.slice(1);

/** Editor chrome on the theme's code canvas (`terminalBackground`). */
export function monacoThemeColors(scheme: ThemeScheme): Record<string, string> {
  const colors = resolveThemeColors(getActiveColorTheme(scheme));
  const canvas = colors.terminalBackground;
  const ink = colors.terminalForeground;
  const dark = scheme === 'dark';
  return {
    'editor.background': canvas,
    'editor.foreground': ink,
    'editorGutter.background': canvas,
    'editor.lineHighlightBackground': mixHexColors(ink, canvas, 0.05),
    'editor.lineHighlightBorder': mixHexColors(ink, canvas, 0.1),
    'editorLineNumber.foreground': mixHexColors(ink, canvas, 0.6),
    'editorLineNumber.activeForeground': ink,
    'editorCursor.foreground': colors.syntaxTag,
    'editor.selectionBackground': withAlpha(
      getAccentColor(scheme),
      dark ? 0.3 : 0.2
    ),
    'editor.inactiveSelectionBackground': withAlpha(
      mixHexColors(ink, canvas, 0.14),
      0.5
    ),
  };
}

function defineSchemeTheme(monaco: MonacoThemeDefiner, scheme: ThemeScheme) {
  const colors = resolveThemeColors(getActiveColorTheme(scheme));
  monaco.editor.defineTheme(THEME_NAMES[scheme], {
    base: scheme === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: bare(colors.syntaxComment) },
      { token: 'keyword', foreground: bare(colors.syntaxKeyword) },
      { token: 'string', foreground: bare(colors.syntaxString) },
      { token: 'number', foreground: bare(colors.syntaxConstant) },
      { token: 'type', foreground: bare(colors.syntaxTag) },
      { token: 'tag', foreground: bare(colors.syntaxTag) },
      { token: 'variable', foreground: bare(colors.syntaxVariable) },
      { token: 'delimiter', foreground: bare(colors.syntaxPunctuation) },
    ],
    colors: monacoThemeColors(scheme),
  });
}

let definedFor: MonacoThemeDefiner | null = null;

function redefineActiveThemes() {
  const monaco = definedFor;
  if (!monaco) return;
  defineSchemeTheme(monaco, 'light');
  defineSchemeTheme(monaco, 'dark');
  monaco.editor.setTheme?.(THEME_NAMES[readDocumentTheme()]);
}

/** Defines both editor themes from the active color themes and keeps them in
 * step when the user switches or edits a theme. */
export function defineColorThemeMonacoThemes(monaco: MonacoThemeDefiner) {
  defineSchemeTheme(monaco, 'light');
  defineSchemeTheme(monaco, 'dark');
  if (definedFor) {
    definedFor = monaco;
    return;
  }
  definedFor = monaco;
  if (typeof window !== 'undefined') {
    window.addEventListener(COLOR_THEME_CHANGED_EVENT, redefineActiveThemes);
    window.addEventListener(ACCENT_COLOR_CHANGED_EVENT, redefineActiveThemes);
  }
}
