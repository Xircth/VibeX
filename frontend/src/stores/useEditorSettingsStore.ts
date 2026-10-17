import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { persistFrontendPreference } from '@/lib/frontendPreferences';
import {
  DEFAULT_MARKDOWN_PREVIEW_MODE,
  parseMarkdownPreviewMode,
  type MarkdownPreviewMode,
} from '@/utils/markdownPreviewMode';

interface EditorSettingsState {
  previewFontSize: number;
  markdownPreviewMode: MarkdownPreviewMode;
  setPreviewFontSize: (fontSize: number) => void;
  setMarkdownPreviewMode: (mode: MarkdownPreviewMode) => void;
}

function persistEditorSettings(
  previewFontSize: number,
  markdownPreviewMode: MarkdownPreviewMode
) {
  persistFrontendPreference('editor-settings', {
    state: { previewFontSize, markdownPreviewMode },
    version: 0,
  });
}

export const useEditorSettingsStore = create<EditorSettingsState>()(
  persist(
    (set, get) => ({
      previewFontSize: 12,
      markdownPreviewMode: DEFAULT_MARKDOWN_PREVIEW_MODE,
      setPreviewFontSize: (fontSize) => {
        const previewFontSize = Math.min(
          24,
          Math.max(10, Math.round(fontSize))
        );
        persistEditorSettings(previewFontSize, get().markdownPreviewMode);
        set({ previewFontSize });
      },
      setMarkdownPreviewMode: (mode) => {
        const markdownPreviewMode = parseMarkdownPreviewMode(mode);
        persistEditorSettings(get().previewFontSize, markdownPreviewMode);
        set({ markdownPreviewMode });
      },
    }),
    {
      name: 'editor-settings',
      merge: (persisted, current) => {
        const stored =
          persisted && typeof persisted === 'object'
            ? (persisted as Partial<EditorSettingsState>)
            : {};
        return {
          ...current,
          ...stored,
          markdownPreviewMode: parseMarkdownPreviewMode(
            stored.markdownPreviewMode
          ),
        };
      },
    }
  )
);
