import { create } from 'zustand';

interface FileTreeState {
  /** Root path currently being browsed */
  rootPath: string | null;
  /** Currently selected file path (for editor) */
  selectedFilePath: string | null;
  /** Set of expanded directory paths */
  expandedDirs: Set<string>;
  /** File path currently open in diff view */
  diffFilePath: string | null;

  /** Actions */
  setRootPath: (path: string | null) => void;
  setSelectedFilePath: (path: string | null) => void;
  toggleDir: (path: string) => void;
  expandDir: (path: string) => void;
  collapseDir: (path: string) => void;
  setDiffFilePath: (path: string | null) => void;
}

export const useFileTreeStore = create<FileTreeState>()((set) => ({
  rootPath: null,
  selectedFilePath: null,
  expandedDirs: new Set<string>(),
  diffFilePath: null,

  setRootPath: (path) => set({ rootPath: path }),

  setSelectedFilePath: (path) => set({ selectedFilePath: path }),

  toggleDir: (path) =>
    set((state) => {
      const next = new Set(state.expandedDirs);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { expandedDirs: next };
    }),

  expandDir: (path) =>
    set((state) => {
      const next = new Set(state.expandedDirs);
      next.add(path);
      return { expandedDirs: next };
    }),

  collapseDir: (path) =>
    set((state) => {
      const next = new Set(state.expandedDirs);
      next.delete(path);
      return { expandedDirs: next };
    }),

  setDiffFilePath: (path) => set({ diffFilePath: path }),
}));
