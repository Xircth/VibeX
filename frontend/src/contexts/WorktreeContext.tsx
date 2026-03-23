import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { useProject } from '@/contexts/ProjectContext';
import { getProjectScopeKey } from '@/lib/projectScope';
import { useProjectViewStateStore } from '@/stores/useProjectViewStateStore';

export interface WorktreeState {
  activeWorktreeId: string | null;
  activeTaskId: string | null;
  setActiveWorktree: (worktreeId: string | null, taskId: string | null) => void;
}

const WorktreeContext = createContext<WorktreeState | null>(null);

export function WorktreeProvider({ children }: { children: ReactNode }) {
  const { projectId } = useProject();
  const projectKey = getProjectScopeKey(projectId);
  const [activeWorktreeId, setWorktreeId] = useState<string | null>(null);
  const [activeTaskId, setTaskId] = useState<string | null>(null);

  useEffect(() => {
    const stored = useProjectViewStateStore.getState().getWorktreeState(projectKey);
    setWorktreeId(stored.activeWorktreeId);
    setTaskId(stored.activeTaskId);
  }, [projectKey]);

  useEffect(() => {
    useProjectViewStateStore.getState().setWorktreeState(projectKey, {
      activeWorktreeId,
      activeTaskId,
    });
  }, [activeTaskId, activeWorktreeId, projectKey]);

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
