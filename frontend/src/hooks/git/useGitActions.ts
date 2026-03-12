import { useCallback, useState } from 'react';
import { attemptsApi } from '@/lib/api';

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

export function useGitActions({
  workspaceId,
  repoId,
  onSuccess,
}: UseGitActionsOptions): UseGitActionsReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wrapAction = useCallback(
    (action: () => Promise<void>) => async () => {
      if (!workspaceId || !repoId) return;
      setIsLoading(true);
      setError(null);
      try {
        await action();
        onSuccess?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsLoading(false);
      }
    },
    [workspaceId, repoId, onSuccess]
  );

  const stageFile = useCallback(
    async (path: string) => {
      if (!workspaceId || !repoId) return;
      setIsLoading(true);
      setError(null);
      try {
        await attemptsApi.stageFile(workspaceId, repoId, path);
        onSuccess?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsLoading(false);
      }
    },
    [workspaceId, repoId, onSuccess]
  );

  const unstageFile = useCallback(
    async (path: string) => {
      if (!workspaceId || !repoId) return;
      setIsLoading(true);
      setError(null);
      try {
        await attemptsApi.unstageFile(workspaceId, repoId, path);
        onSuccess?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsLoading(false);
      }
    },
    [workspaceId, repoId, onSuccess]
  );

  const revertFile = useCallback(
    async (path: string) => {
      if (!workspaceId || !repoId) return;
      setIsLoading(true);
      setError(null);
      try {
        await attemptsApi.revertFile(workspaceId, repoId, path);
        onSuccess?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsLoading(false);
      }
    },
    [workspaceId, repoId, onSuccess]
  );

  const stageAll = useCallback(
    wrapAction(async () => {
      await attemptsApi.stageAll(workspaceId!, repoId!);
    }),
    [workspaceId, repoId, wrapAction]
  );

  const revertAll = useCallback(
    wrapAction(async () => {
      await attemptsApi.revertAll(workspaceId!, repoId!);
    }),
    [workspaceId, repoId, wrapAction]
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
