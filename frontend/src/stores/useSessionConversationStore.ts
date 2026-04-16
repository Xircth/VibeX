import { create } from 'zustand';
import type { TokenUsageInfo } from 'shared/types';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory';

const MAX_SESSION_SNAPSHOTS = 100;

export interface SessionConversationSnapshot {
  entries: PatchTypeWithKey[];
  tokenUsageInfo: TokenUsageInfo | null;
  updatedAt: number;
}

interface SessionConversationStore {
  snapshots: Record<string, SessionConversationSnapshot>;
  getSnapshot: (key?: string) => SessionConversationSnapshot | null;
  saveSnapshot: (
    key: string,
    snapshot: Omit<SessionConversationSnapshot, 'updatedAt'>
  ) => void;
  clearSnapshot: (key?: string) => void;
}

export const useSessionConversationStore = create<SessionConversationStore>(
  (set, get) => ({
    snapshots: {},
    getSnapshot: (key) => {
      if (!key) return null;
      return get().snapshots[key] ?? null;
    },
    saveSnapshot: (key, snapshot) =>
      set((state) => {
        const nextSnapshots = {
          ...state.snapshots,
          [key]: {
            entries: structuredClone(snapshot.entries),
            tokenUsageInfo: snapshot.tokenUsageInfo,
            updatedAt: Date.now(),
          },
        };

        const snapshotKeys = Object.keys(nextSnapshots);
        if (snapshotKeys.length > MAX_SESSION_SNAPSHOTS) {
          const oldestKey = snapshotKeys.sort(
            (a, b) => nextSnapshots[a].updatedAt - nextSnapshots[b].updatedAt
          )[0];
          if (oldestKey) {
            delete nextSnapshots[oldestKey];
          }
        }

        return { snapshots: nextSnapshots };
      }),
    clearSnapshot: (key) =>
      set((state) => {
        if (!key) {
          return state;
        }

        const nextSnapshots = { ...state.snapshots };
        delete nextSnapshots[key];
        return { snapshots: nextSnapshots };
      }),
  })
);
