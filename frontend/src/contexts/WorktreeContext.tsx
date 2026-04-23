import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { useParams } from 'react-router-dom';
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
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { projectId } = useProject();
  const projectKey = getProjectScopeKey(projectId);
  const routeWorktreeId = useMemo(() => workspaceId ?? null, [workspaceId]);
  const [activeWorktreeId, setWorktreeId] = useState<string | null>(() => {
    const stored = useProjectViewStateStore
      .getState()
      .getWorktreeState(projectKey);
    return routeWorktreeId ?? stored.activeWorktreeId;
  });
  const [activeTaskId, setTaskId] = useState<string | null>(() => {
    const stored = useProjectViewStateStore
      .getState()
      .getWorktreeState(projectKey);
    return routeWorktreeId ? null : stored.activeTaskId;
  });

  useEffect(() => {
    const stored = useProjectViewStateStore
      .getState()
      .getWorktreeState(projectKey);
    const nextWorktreeId = routeWorktreeId ?? stored.activeWorktreeId;
    const nextTaskId = routeWorktreeId ? null : stored.activeTaskId;

    setWorktreeId((current) =>
      current === nextWorktreeId ? current : nextWorktreeId
    );
    setTaskId((current) => (current === nextTaskId ? current : nextTaskId));
  }, [projectKey, routeWorktreeId]);

  useEffect(() => {
    useProjectViewStateStore.getState().setWorktreeState(projectKey, {
      activeWorktreeId,
      activeTaskId,
    });
  }, [activeTaskId, activeWorktreeId, projectKey]);

  const setActiveWorktree = useCallback(
    (worktreeId: string | null, taskId: string | null) => {
      setWorktreeId(worktreeId);
      setTaskId(taskId);
    },
    []
  );

  return (
    <WorktreeContext.Provider
      value={{ activeWorktreeId, activeTaskId, setActiveWorktree }}
    >
      {children}
    </WorktreeContext.Provider>
  );
}

export function useWorktree(): WorktreeState {
  const ctx = useContext(WorktreeContext);
  if (!ctx) throw new Error('useWorktree must be used within WorktreeProvider');
  return ctx;
}
