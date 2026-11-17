import { useCallback, useSyncExternalStore } from 'react';
import type { AgentKind } from 'shared/types';

export type PendingForkHandoff = {
  id: number;
  sessionId: string;
  fromAgent: AgentKind | string;
  toAgent: AgentKind | string;
  fromModelLabel: string | null;
  toModelLabel: string | null;
};

let nextForkEntryId = 1;
let currentPendingFork: PendingForkHandoff | null = null;
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

export function beginPendingForkHandoff(input: {
  sessionId: string;
  fromAgent: AgentKind | string;
  toAgent: AgentKind | string;
  fromModelLabel?: string | null;
  toModelLabel?: string | null;
}): number {
  const id = nextForkEntryId;
  nextForkEntryId += 1;
  currentPendingFork = {
    id,
    sessionId: input.sessionId,
    fromAgent: input.fromAgent,
    toAgent: input.toAgent,
    fromModelLabel: input.fromModelLabel ?? null,
    toModelLabel: input.toModelLabel ?? null,
  };
  notifyListeners();
  return id;
}

export function endPendingForkHandoff(id: number): void {
  if (!currentPendingFork || currentPendingFork.id !== id) {
    return;
  }
  currentPendingFork = null;
  notifyListeners();
}

export function usePendingForkHandoff(
  sessionId: string | null | undefined
): PendingForkHandoff | null {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const getSnapshot = useCallback(() => {
    if (!sessionId || !currentPendingFork) return null;
    return currentPendingFork.sessionId === sessionId
      ? currentPendingFork
      : null;
  }, [sessionId]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
