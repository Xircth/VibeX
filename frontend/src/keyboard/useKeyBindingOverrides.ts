import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { KeyBindingOverrides } from './registry';
import { persistFrontendPreference } from '@/lib/frontendPreferences';

/**
 * User keybinding overrides (P3-2). Frontend-only, localStorage-persisted
 * (consistent with uiZoom / uiLanguage) — a map of binding id → single chord
 * token that replaces the registry default. Consumed live by useSemanticKey and
 * edited by ShortcutSettings.
 */
interface KeyBindingOverridesState {
  overrides: KeyBindingOverrides;
  setOverride: (id: string, chord: string) => void;
  clearOverride: (id: string) => void;
  clearAll: () => void;
}

export const useKeyBindingOverridesStore = create<KeyBindingOverridesState>()(
  persist(
    (set) => ({
      overrides: {},
      setOverride: (id, chord) =>
        set((state) => {
          const overrides = { ...state.overrides, [id]: chord };
          persistFrontendPreference('vibex:key-overrides', {
            state: { overrides },
            version: 1,
          });
          return { overrides };
        }),
      clearOverride: (id) =>
        set((state) => {
          if (!(id in state.overrides)) return state;
          const next = { ...state.overrides };
          delete next[id];
          persistFrontendPreference('vibex:key-overrides', {
            state: { overrides: next },
            version: 1,
          });
          return { overrides: next };
        }),
      clearAll: () =>
        set((state) => {
          if (Object.keys(state.overrides).length === 0) return state;
          persistFrontendPreference('vibex:key-overrides', {
            state: { overrides: {} },
            version: 1,
          });
          return { overrides: {} };
        }),
    }),
    { name: 'vibex:key-overrides', version: 1 }
  )
);
