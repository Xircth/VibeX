import { create } from 'zustand';

export type PromptEnhancementOwnerKey = string;

export type PromptEnhancementRunStatus = 'running' | 'success' | 'error';

export type PromptEnhancementRun = {
  ownerKey: PromptEnhancementOwnerKey;
  generation: number;
  status: PromptEnhancementRunStatus;
  enhancedPrompt?: string;
  error?: string;
};

interface PromptEnhancementState {
  runs: Record<PromptEnhancementOwnerKey, PromptEnhancementRun>;
  begin: (ownerKey: PromptEnhancementOwnerKey) => number;
  succeed: (
    ownerKey: PromptEnhancementOwnerKey,
    generation: number,
    enhancedPrompt: string
  ) => void;
  fail: (
    ownerKey: PromptEnhancementOwnerKey,
    generation: number,
    error: string
  ) => void;
  cancel: (ownerKey: PromptEnhancementOwnerKey, generation?: number) => void;
  consume: (ownerKey: PromptEnhancementOwnerKey) => PromptEnhancementRun | null;
}

export function promptEnhancementOwnerKey(
  sessionId: string | null | undefined,
  workspaceId: string | null | undefined
): PromptEnhancementOwnerKey {
  if (sessionId) return `session:${sessionId}`;
  if (workspaceId) return `workspace:${workspaceId}`;
  return 'unscoped';
}

export const usePromptEnhancementStore = create<PromptEnhancementState>(
  (set, get) => ({
    runs: {},
    begin: (ownerKey) => {
      const current = get().runs[ownerKey];
      const generation = (current?.generation ?? 0) + 1;
      set((state) => ({
        runs: {
          ...state.runs,
          [ownerKey]: {
            ownerKey,
            generation,
            status: 'running',
          },
        },
      }));
      return generation;
    },
    succeed: (ownerKey, generation, enhancedPrompt) => {
      const current = get().runs[ownerKey];
      if (!current || current.generation !== generation) return;
      set((state) => ({
        runs: {
          ...state.runs,
          [ownerKey]: {
            ownerKey,
            generation,
            status: 'success',
            enhancedPrompt,
          },
        },
      }));
    },
    fail: (ownerKey, generation, error) => {
      const current = get().runs[ownerKey];
      if (!current || current.generation !== generation) return;
      set((state) => ({
        runs: {
          ...state.runs,
          [ownerKey]: {
            ownerKey,
            generation,
            status: 'error',
            error,
          },
        },
      }));
    },
    cancel: (ownerKey, generation) => {
      const current = get().runs[ownerKey];
      if (!current) return;
      if (generation != null && current.generation !== generation) return;
      set((state) => {
        const next = { ...state.runs };
        delete next[ownerKey];
        return { runs: next };
      });
    },
    consume: (ownerKey) => {
      const current = get().runs[ownerKey] ?? null;
      if (!current || current.status === 'running') return null;
      set((state) => {
        const next = { ...state.runs };
        delete next[ownerKey];
        return { runs: next };
      });
      return current;
    },
  })
);

export function resetPromptEnhancementStoreForTests() {
  usePromptEnhancementStore.setState({ runs: {} });
}
