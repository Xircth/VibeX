import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { KeyBindingOverrides } from './registry';

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
        set((state) => ({ overrides: { ...state.overrides, [id]: chord } })),
      clearOverride: (id) =>
        set((state) => {
          if (!(id in state.overrides)) return state;
          const next = { ...state.overrides };
          delete next[id];
          return { overrides: next };
        }),
      clearAll: () =>
        set((state) =>
          Object.keys(state.overrides).length === 0
            ? state
            : { overrides: {} }
        ),
    }),
    { name: 'vibex:key-overrides', version: 1 }
  )
);
