import { createContext, useContext } from 'react';

import type { CollaborationSpaceRuntime } from './CollaborationSpaceRuntime';

export type CollaborationSpaceListener = () => void;

export interface CollaborationSpaceStore {
  getSnapshot: () => CollaborationSpaceRuntime;
  subscribe: (listener: CollaborationSpaceListener) => () => void;
}

export const CollaborationSpaceStoreContext =
  createContext<CollaborationSpaceStore | null>(null);

export function useHasCollaborationSpaceProvider(): boolean {
  return useContext(CollaborationSpaceStoreContext) !== null;
}

export function useOptionalCollaborationSpaceStore(): CollaborationSpaceStore | null {
  return useContext(CollaborationSpaceStoreContext);
}
