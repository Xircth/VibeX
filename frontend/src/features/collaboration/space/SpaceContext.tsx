import { createContext, useContext, type ReactNode } from 'react';

import {
  useCollaborationSpaceRuntime,
  type CollaborationSpaceRuntime,
} from './CollaborationSpaceRuntime';

const CollaborationSpaceContext =
  createContext<CollaborationSpaceRuntime | null>(null);

export function CollaborationSpaceProvider({
  workspaceId,
  children,
}: {
  workspaceId: string | null;
  children: ReactNode;
}) {
  const value = useCollaborationSpaceRuntime(workspaceId);
  return (
    <CollaborationSpaceContext.Provider value={value}>
      {children}
    </CollaborationSpaceContext.Provider>
  );
}

export function useCollaborationSpace(): CollaborationSpaceRuntime {
  const value = useContext(CollaborationSpaceContext);
  if (!value) {
    throw new Error(
      'useCollaborationSpace must be used within CollaborationSpaceProvider'
    );
  }
  return value;
}
