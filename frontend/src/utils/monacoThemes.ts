export const MONACO_THEME_AYU_LIGHT = 'vibe-ayu-light';
export const MONACO_THEME_AYU_DARK = 'vibe-ayu-dark';

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
  };
};

export function defineAyuMonacoThemes(monaco: MonacoThemeDefiner) {
  monaco.editor.defineTheme(MONACO_THEME_AYU_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#FAFAFA',
      'editorGutter.background': '#FAFAFA',
      'editor.lineHighlightBackground': '#F0F0F0',
      'editor.lineHighlightBorder': '#E1E1E2',
      'editorLineNumber.foreground': '#8A9199',
      'editorLineNumber.activeForeground': '#5C6166',
      'editorCursor.foreground': '#55B4D4',
      'editor.selectionBackground': '#5B8CC733',
      'editor.inactiveSelectionBackground': '#DDE6F780',
    },
  });

  monaco.editor.defineTheme(MONACO_THEME_AYU_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1F2430',
      'editorGutter.background': '#1F2430',
      'editor.lineHighlightBackground': '#232834',
      'editor.lineHighlightBorder': '#2A2F3A',
      'editorLineNumber.foreground': '#5C6773',
      'editorLineNumber.activeForeground': '#B8C4D0',
      'editorCursor.foreground': '#5CCFE6',
      'editor.selectionBackground': '#5B8CC74D',
      'editor.inactiveSelectionBackground': '#3B425280',
    },
  });
}
