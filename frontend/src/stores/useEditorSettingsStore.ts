import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { persistFrontendPreference } from '@/lib/frontendPreferences';

interface EditorSettingsState {
  previewFontSize: number;
  setPreviewFontSize: (fontSize: number) => void;
}

export const useEditorSettingsStore = create<EditorSettingsState>()(
  persist(
    (set) => ({
      previewFontSize: 12,
      setPreviewFontSize: (fontSize) => {
        const previewFontSize = Math.min(
          24,
          Math.max(10, Math.round(fontSize))
        );
        persistFrontendPreference('editor-settings', {
          state: { previewFontSize },
          version: 0,
        });
        set({ previewFontSize });
      },
    }),
    {
      name: 'editor-settings',
    }
  )
);
