import { useCallback, useEffect, useState } from 'react';
import { attemptsApi, repoApi } from '@/lib/api';
import type { GitBranch } from 'shared/types';

interface UseGitBranchesOptions {
  workspaceId: string | null;
  repoId: string | null;
  enabled?: boolean;
}

interface UseGitBranchesReturn {
  branches: GitBranch[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  checkoutBranch: (name: string) => Promise<void>;
  createBranch: (name: string, fromRef?: string) => Promise<void>;
  deleteBranch: (name: string) => Promise<void>;
}

export function useGitBranches({
  workspaceId,
  repoId,
  enabled = true,
}: UseGitBranchesOptions): UseGitBranchesReturn {
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!repoId) return;
    setIsLoading(true);
    setError(null);
    try {
      const result = await repoApi.getBranches(repoId);
      const sorted = [...result].sort((a, b) => {
        if (a.is_current && !b.is_current) return -1;
        if (!a.is_current && b.is_current) return 1;
        return new Date(b.last_commit_date).getTime() - new Date(a.last_commit_date).getTime();
      });
      setBranches(sorted);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, [repoId]);

  useEffect(() => {
    if (enabled && repoId) {
      refresh();
    }
  }, [enabled, repoId, refresh]);

  const checkoutBranch = useCallback(
    async (name: string) => {
      if (!workspaceId || !repoId) return;
      setError(null);
      try {
        await attemptsApi.checkoutBranch(workspaceId, repoId, name);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [workspaceId, repoId, refresh]
  );

  const createBranch = useCallback(
    async (name: string, fromRef?: string) => {
      if (!workspaceId || !repoId) return;
      setError(null);
      try {
        await attemptsApi.createBranch(workspaceId, repoId, name, fromRef);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [workspaceId, repoId, refresh]
  );

  const deleteBranch = useCallback(
    async (name: string) => {
      if (!workspaceId || !repoId) return;
      setError(null);
      try {
        await attemptsApi.deleteBranch(workspaceId, repoId, name);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [workspaceId, repoId, refresh]
  );

  return {
    branches,
    isLoading,
    error,
    refresh,
    checkoutBranch,
    createBranch,
    deleteBranch,
  };
}
