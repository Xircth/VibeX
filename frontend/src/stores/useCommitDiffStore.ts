import { create } from 'zustand';
import type { CommitDetail, Diff } from 'shared/types';

interface CommitDiffState {
  /** Current commit SHA being viewed in the Diffs panel */
  commitSha: string | null;
  /** Commit metadata (summary, author, etc.) */
  commitInfo: CommitDetail | null;
  /** Full diff data for the commit */
  commitDiffs: Diff[];
  /** Loading state */
  isLoading: boolean;

  /** Set commit diff data (called when user clicks a commit in GitLogView) */
  setCommitDiff: (sha: string, info: CommitDetail, diffs: Diff[]) => void;
  /** Clear commit diff state (return to worktree diff mode) */
  clearCommitDiff: () => void;
  /** Set loading state */
  setLoading: (loading: boolean) => void;
}

export const useCommitDiffStore = create<CommitDiffState>((set) => ({
  commitSha: null,
  commitInfo: null,
  commitDiffs: [],
  isLoading: false,

  setCommitDiff: (sha, info, diffs) =>
    set({
      commitSha: sha,
      commitInfo: info,
      commitDiffs: diffs,
      isLoading: false,
    }),

  clearCommitDiff: () =>
    set({
      commitSha: null,
      commitInfo: null,
      commitDiffs: [],
      isLoading: false,
    }),

  setLoading: (loading) => set({ isLoading: loading }),
}));
