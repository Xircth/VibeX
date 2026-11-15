import { useSyncExternalStore } from 'react';

const hosts: HTMLElement[] = [];
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

export function registerWorkspaceStageCreationHost(
  host: HTMLElement
): () => void {
  hosts.push(host);
  emitChange();
  return () => {
    const index = hosts.indexOf(host);
    if (index !== -1) {
      hosts.splice(index, 1);
      emitChange();
    }
  };
}

export function getWorkspaceStageCreationHost(): HTMLElement | null {
  return hosts.at(-1) ?? null;
}

export function useWorkspaceStageCreationHost(): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getWorkspaceStageCreationHost,
    () => null
  );
}
