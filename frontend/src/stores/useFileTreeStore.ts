import { create } from 'zustand';

export type FileTreeNodeType = 'file' | 'folder';

export interface FileTreeRevealTarget {
  path: string;
  nodeType: FileTreeNodeType;
  requestId: number;
}

interface FileTreeState {
  /** Root path currently being browsed */
  rootPath: string | null;
  /** Currently selected file path (for editor) */
  selectedFilePath: string | null;
  /** Set of expanded directory paths */
  expandedDirs: Set<string>;
  /** File path currently open in diff view */
  diffFilePath: string | null;
  /** Pending request to reveal a path inside the file tree */
  revealTarget: FileTreeRevealTarget | null;

  /** Actions */
  setRootPath: (path: string | null) => void;
  setSelectedFilePath: (path: string | null) => void;
  toggleDir: (path: string) => void;
  expandDir: (path: string) => void;
  collapseDir: (path: string) => void;
  setDiffFilePath: (path: string | null) => void;
  revealInTree: (path: string, nodeType: FileTreeNodeType) => void;
}

let nextRevealRequestId = 1;

export const useFileTreeStore = create<FileTreeState>()((set) => ({
  rootPath: null,
  selectedFilePath: null,
  expandedDirs: new Set<string>(),
  diffFilePath: null,
  revealTarget: null,

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

  revealInTree: (path, nodeType) =>
    set({
      revealTarget: {
        path,
        nodeType,
        requestId: nextRevealRequestId++,
      },
      selectedFilePath: nodeType === 'file' ? path : null,
    }),
}));
