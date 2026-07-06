import { create } from 'zustand';

/** A code selection pending insertion into the session composer (P2-4). */
export interface PendingComposerSelection {
  /** Repo-relative file path. */
  filePath: string;
  startLine: number;
  endLine: number;
}

interface ComposerSelectionState {
  pending: PendingComposerSelection | null;
  /** File viewers call this to request "add selection to chat". */
  requestInsert: (selection: PendingComposerSelection) => void;
  /** The composer calls this once it has consumed the pending selection. */
  consume: () => PendingComposerSelection | null;
}

export const useComposerSelectionStore = create<ComposerSelectionState>(
  (set, get) => ({
    pending: null,
    requestInsert: (selection) => set({ pending: selection }),
    consume: () => {
      const pending = get().pending;
      if (pending) set({ pending: null });
      return pending;
    },
  })
);
