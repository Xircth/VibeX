import { useCallback, useState } from 'react';
import { attemptsApi, repoApi } from '@/lib/api';

interface UseGitActionsOptions {
  workspaceId: string | null;
  repoId: string | null;
  onSuccess?: () => void;
}

interface UseGitActionsReturn {
  stageFile: (path: string) => Promise<void>;
  unstageFile: (path: string) => Promise<void>;
  revertFile: (path: string) => Promise<void>;
  stageAll: () => Promise<void>;
  revertAll: () => Promise<void>;
  isLoading: boolean;
  error: string | null;
}

function makeGitAction<Args extends unknown[]>(
  workspaceId: string | null,
  repoId: string | null,
  setIsLoading: (v: boolean) => void,
  setError: (v: string | null) => void,
  onSuccess: (() => void) | undefined,
  workspaceCall: (wid: string, rid: string, ...args: Args) => Promise<unknown>,
  repoCall: (rid: string, ...args: Args) => Promise<unknown>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    if (!repoId) return;
    setIsLoading(true);
    setError(null);
    try {
      if (workspaceId) {
        await workspaceCall(workspaceId, repoId, ...args);
      } else {
        await repoCall(repoId, ...args);
      }
      onSuccess?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  };
}

export function useGitActions({
  workspaceId,
  repoId,
  onSuccess,
}: UseGitActionsOptions): UseGitActionsReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deps = [workspaceId, repoId, onSuccess];

  const stageFile = useCallback(
    makeGitAction(workspaceId, repoId, setIsLoading, setError, onSuccess,
      attemptsApi.stageFile, repoApi.stageFile),
    deps
  );

  const unstageFile = useCallback(
    makeGitAction(workspaceId, repoId, setIsLoading, setError, onSuccess,
      attemptsApi.unstageFile, repoApi.unstageFile),
    deps
  );

  const revertFile = useCallback(
    makeGitAction(workspaceId, repoId, setIsLoading, setError, onSuccess,
      attemptsApi.revertFile, repoApi.revertFile),
    deps
  );

  const stageAll = useCallback(
    makeGitAction(workspaceId, repoId, setIsLoading, setError, onSuccess,
      attemptsApi.stageAll, repoApi.stageAll),
    deps
  );

  const revertAll = useCallback(
    makeGitAction(workspaceId, repoId, setIsLoading, setError, onSuccess,
      attemptsApi.revertAll, repoApi.revertAll),
    deps
  );

  return {
    stageFile,
    unstageFile,
    revertFile,
    stageAll,
    revertAll,
    isLoading,
    error,
  };
}
