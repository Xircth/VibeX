import { create } from 'zustand';
import {
  emptyFileTreeLazyListing,
  type FileTreeLazyListing,
} from '@/components/file-tree/file-tree-utils';

export type FileTreeNodeType = 'file' | 'folder';

export interface FileTreeRevealTarget {
  path: string;
  nodeType: FileTreeNodeType;
  requestId: number;
}

export type FileTreeExpandedUpdater =
  | Set<string>
  | ((previous: Set<string>) => Set<string>);

export type FileTreeLazyListingUpdater =
  | FileTreeLazyListing
  | ((previous: FileTreeLazyListing) => FileTreeLazyListing);

export const EMPTY_EXPANDED_FOLDERS: ReadonlySet<string> = new Set<string>();
export const EMPTY_LAZY_LISTING = emptyFileTreeLazyListing();

interface FileTreeState {
  /** Root path currently being browsed */
  rootPath: string | null;
  /** Currently selected file path (for editor) */
  selectedFilePath: string | null;
  /** Expanded directory paths keyed by workspace root */
  expandedByRoot: Record<string, Set<string>>;
  /** Lazy directory listings keyed by workspace root */
  lazyListingByRoot: Record<string, FileTreeLazyListing>;
  /** File path currently open in diff view */
  diffFilePath: string | null;
  /** Pending request to reveal a path inside the file tree */
  revealTarget: FileTreeRevealTarget | null;

  /** Actions */
  setRootPath: (path: string | null) => void;
  setSelectedFilePath: (path: string | null) => void;
  expandedFoldersFor: (rootPath: string) => Set<string>;
  setExpandedFolders: (
    rootPath: string,
    update: FileTreeExpandedUpdater
  ) => void;
  lazyListingFor: (rootPath: string) => FileTreeLazyListing;
  setLazyListing: (
    rootPath: string,
    update: FileTreeLazyListingUpdater
  ) => void;
  toggleDir: (path: string) => void;
  expandDir: (path: string) => void;
  collapseDir: (path: string) => void;
  setDiffFilePath: (path: string | null) => void;
  revealInTree: (path: string, nodeType: FileTreeNodeType) => void;
}

let nextRevealRequestId = 1;

function updateExpandedForRoot(
  expandedByRoot: Record<string, Set<string>>,
  rootPath: string,
  update: FileTreeExpandedUpdater
): Record<string, Set<string>> {
  const previous =
    expandedByRoot[rootPath] ?? (EMPTY_EXPANDED_FOLDERS as Set<string>);
  const next = typeof update === 'function' ? update(previous) : update;
  if (next === previous) {
    return expandedByRoot;
  }
  return { ...expandedByRoot, [rootPath]: next };
}

export const useFileTreeStore = create<FileTreeState>()((set, get) => ({
  rootPath: null,
  selectedFilePath: null,
  expandedByRoot: {},
  lazyListingByRoot: {},
  diffFilePath: null,
  revealTarget: null,

  setRootPath: (path) => set({ rootPath: path }),

  setSelectedFilePath: (path) => set({ selectedFilePath: path }),

  expandedFoldersFor: (rootPath) =>
    get().expandedByRoot[rootPath] ?? (EMPTY_EXPANDED_FOLDERS as Set<string>),

  setExpandedFolders: (rootPath, update) =>
    set((state) => {
      const expandedByRoot = updateExpandedForRoot(
        state.expandedByRoot,
        rootPath,
        update
      );
      if (expandedByRoot === state.expandedByRoot) {
        return state;
      }
      return { expandedByRoot };
    }),

  lazyListingFor: (rootPath) =>
    get().lazyListingByRoot[rootPath] ?? EMPTY_LAZY_LISTING,

  setLazyListing: (rootPath, update) =>
    set((state) => {
      const previous = state.lazyListingByRoot[rootPath] ?? EMPTY_LAZY_LISTING;
      const next = typeof update === 'function' ? update(previous) : update;
      if (next === previous) {
        return state;
      }
      return {
        lazyListingByRoot: {
          ...state.lazyListingByRoot,
          [rootPath]: next,
        },
      };
    }),

  toggleDir: (path) =>
    set((state) => {
      if (!state.rootPath) {
        return state;
      }
      return {
        expandedByRoot: updateExpandedForRoot(
          state.expandedByRoot,
          state.rootPath,
          (previous) => {
            const next = new Set(previous);
            if (next.has(path)) {
              next.delete(path);
            } else {
              next.add(path);
            }
            return next;
          }
        ),
      };
    }),

  expandDir: (path) =>
    set((state) => {
      if (!state.rootPath) {
        return state;
      }
      return {
        expandedByRoot: updateExpandedForRoot(
          state.expandedByRoot,
          state.rootPath,
          (previous) => {
            if (previous.has(path)) {
              return previous;
            }
            const next = new Set(previous);
            next.add(path);
            return next;
          }
        ),
      };
    }),

  collapseDir: (path) =>
    set((state) => {
      if (!state.rootPath) {
        return state;
      }
      return {
        expandedByRoot: updateExpandedForRoot(
          state.expandedByRoot,
          state.rootPath,
          (previous) => {
            if (!previous.has(path)) {
              return previous;
            }
            const next = new Set(previous);
            next.delete(path);
            return next;
          }
        ),
      };
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
