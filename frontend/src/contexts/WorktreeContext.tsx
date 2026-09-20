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
  const [worktreeState, setWorktreeState] = useState({
    projectKey,
    activeWorktreeId: routeWorktreeId,
    activeTaskId: null as string | null,
  });

  let currentWorktreeState = worktreeState;
  if (worktreeState.projectKey !== projectKey) {
    currentWorktreeState = {
      projectKey,
      activeWorktreeId: routeWorktreeId,
      activeTaskId: null,
    };
    setWorktreeState(currentWorktreeState);
  }

  const activeWorktreeId = currentWorktreeState.activeWorktreeId;
  const activeTaskId = currentWorktreeState.activeTaskId;

  useEffect(() => {
    setWorktreeState((current) =>
      current.projectKey === projectKey &&
      current.activeWorktreeId === routeWorktreeId
        ? current
        : {
            projectKey,
            activeWorktreeId: routeWorktreeId,
            activeTaskId: null,
          }
    );
  }, [projectKey, routeWorktreeId]);

  useEffect(() => {
    useProjectViewStateStore.getState().setWorktreeState(projectKey, {
      activeWorktreeId,
      activeTaskId,
    });
  }, [activeTaskId, activeWorktreeId, projectKey]);

  const setActiveWorktree = useCallback(
    (worktreeId: string | null, taskId: string | null) => {
      setWorktreeState((current) => ({
        ...current,
        activeWorktreeId: worktreeId,
        activeTaskId: taskId,
      }));
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
