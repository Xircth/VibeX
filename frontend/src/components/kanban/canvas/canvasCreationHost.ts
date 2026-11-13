import { useSyncExternalStore } from 'react';

const hosts: HTMLElement[] = [];
const listeners = new Set<() => void>();

export function registerCanvasCreationHost(host: HTMLElement): () => void {
  hosts.push(host);
  listeners.forEach((listener) => listener());
  return () => {
    const index = hosts.indexOf(host);
    if (index !== -1) hosts.splice(index, 1);
    listeners.forEach((listener) => listener());
  };
}

export function useCanvasCreationHost(): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => hosts.at(-1) ?? null,
    () => null
  );
}
