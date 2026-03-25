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

function getRouteWorktreeState(
  attemptId?: string,
  taskId?: string
): Pick<WorktreeState, 'activeWorktreeId' | 'activeTaskId'> | null {
  const activeWorktreeId =
    attemptId && attemptId !== 'latest' ? attemptId : null;

  if (!activeWorktreeId) {
    return null;
  }

  return {
    activeWorktreeId,
    activeTaskId: taskId ?? null,
  };
}

export function WorktreeProvider({ children }: { children: ReactNode }) {
  const { attemptId, taskId } = useParams<{
    attemptId?: string;
    taskId?: string;
  }>();
  const { projectId } = useProject();
  const projectKey = getProjectScopeKey(projectId);
  const routeWorktreeState = useMemo(
    () => getRouteWorktreeState(attemptId, taskId),
    [attemptId, taskId]
  );
  const [activeWorktreeId, setWorktreeId] = useState<string | null>(() => {
    const stored = useProjectViewStateStore
      .getState()
      .getWorktreeState(projectKey);
    return routeWorktreeState?.activeWorktreeId ?? stored.activeWorktreeId;
  });
  const [activeTaskId, setTaskId] = useState<string | null>(() => {
    const stored = useProjectViewStateStore
      .getState()
      .getWorktreeState(projectKey);
    return routeWorktreeState?.activeTaskId ?? stored.activeTaskId;
  });

  useEffect(() => {
    const stored = useProjectViewStateStore
      .getState()
      .getWorktreeState(projectKey);
    const nextWorktreeId =
      routeWorktreeState?.activeWorktreeId ?? stored.activeWorktreeId;
    const nextTaskId = routeWorktreeState?.activeTaskId ?? stored.activeTaskId;

    setWorktreeId((current) =>
      current === nextWorktreeId ? current : nextWorktreeId
    );
    setTaskId((current) => (current === nextTaskId ? current : nextTaskId));
  }, [projectKey, routeWorktreeState]);

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
