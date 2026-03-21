import { create } from 'zustand';

interface GitDiffNavigationState {
  targetPath: string | null;
  requestToken: number;
  focusPath: (path: string) => void;
  clearTargetPath: () => void;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

export const useGitDiffNavigationStore = create<GitDiffNavigationState>(
  (set) => ({
    targetPath: null,
    requestToken: 0,
    focusPath: (path) =>
      set((state) => ({
        targetPath: normalizePath(path),
        requestToken: state.requestToken + 1,
      })),
    clearTargetPath: () => set({ targetPath: null }),
  })
);
