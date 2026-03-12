import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export interface WorktreeState {
  activeWorktreeId: string | null;
  activeTaskId: string | null;
  setActiveWorktree: (worktreeId: string | null, taskId: string | null) => void;
}

const WorktreeContext = createContext<WorktreeState | null>(null);

export function WorktreeProvider({ children }: { children: ReactNode }) {
  const [activeWorktreeId, setWorktreeId] = useState<string | null>(null);
  const [activeTaskId, setTaskId] = useState<string | null>(null);

  const setActiveWorktree = useCallback((worktreeId: string | null, taskId: string | null) => {
    setWorktreeId(worktreeId);
    setTaskId(taskId);
  }, []);

  return (
    <WorktreeContext.Provider value={{ activeWorktreeId, activeTaskId, setActiveWorktree }}>
      {children}
    </WorktreeContext.Provider>
  );
}

export function useWorktree(): WorktreeState {
  const ctx = useContext(WorktreeContext);
  if (!ctx) throw new Error('useWorktree must be used within WorktreeProvider');
  return ctx;
}
