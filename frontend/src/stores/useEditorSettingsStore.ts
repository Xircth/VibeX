import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface EditorSettingsState {
  previewFontSize: number;
  setPreviewFontSize: (fontSize: number) => void;
}

export const useEditorSettingsStore = create<EditorSettingsState>()(
  persist(
    (set) => ({
      previewFontSize: 12,
      setPreviewFontSize: (fontSize) =>
        set({
          previewFontSize: Math.min(24, Math.max(10, Math.round(fontSize))),
        }),
    }),
    {
      name: 'editor-settings',
    }
  )
);
