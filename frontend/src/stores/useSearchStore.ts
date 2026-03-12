import { create } from 'zustand';

interface SearchState {
  /** Whether the quick search palette (Ctrl+P) is open */
  isSearchPaletteOpen: boolean;

  /** Quick search palette query */
  paletteQuery: string;

  /** Selected index in the palette result list */
  paletteSelectedIndex: number;

  /** Actions */
  openSearchPalette: () => void;
  closeSearchPalette: () => void;
  setPaletteQuery: (query: string) => void;
  setPaletteSelectedIndex: (index: number) => void;
  movePaletteSelection: (direction: 'up' | 'down', maxIndex: number) => void;
}

export const useSearchStore = create<SearchState>()((set) => ({
  isSearchPaletteOpen: false,
  paletteQuery: '',
  paletteSelectedIndex: 0,

  openSearchPalette: () =>
    set({
      isSearchPaletteOpen: true,
      paletteQuery: '',
      paletteSelectedIndex: 0,
    }),

  closeSearchPalette: () =>
    set({
      isSearchPaletteOpen: false,
      paletteQuery: '',
      paletteSelectedIndex: 0,
    }),

  setPaletteQuery: (query) =>
    set({ paletteQuery: query, paletteSelectedIndex: 0 }),

  setPaletteSelectedIndex: (index) =>
    set({ paletteSelectedIndex: index }),

  movePaletteSelection: (direction, maxIndex) =>
    set((state) => {
      if (maxIndex <= 0) return state;
      const current = state.paletteSelectedIndex;
      const next =
        direction === 'down'
          ? current >= maxIndex ? 0 : current + 1
          : current <= 0 ? maxIndex : current - 1;
      return { paletteSelectedIndex: next };
    }),
}));
