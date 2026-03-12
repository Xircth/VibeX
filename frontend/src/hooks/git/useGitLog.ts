import { useCallback, useEffect, useRef, useState } from 'react';
import { attemptsApi } from '@/lib/api';
import type { GitLogEntry, GitLogStatus } from 'shared/types';

interface UseGitLogOptions {
  workspaceId: string | null;
  repoId: string | null;
  enabled?: boolean;
}

interface UseGitLogReturn {
  entries: GitLogEntry[];
  total: number;
  ahead: number;
  behind: number;
  upstream: string | null;
  branchName: string;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const EMPTY_ENTRIES: GitLogEntry[] = [];

export function useGitLog({
  workspaceId,
  repoId,
  enabled = true,
}: UseGitLogOptions): UseGitLogReturn {
  const [logStatus, setLogStatus] = useState<GitLogStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!workspaceId || !repoId) return;

    const id = ++requestIdRef.current;
    setIsLoading(true);
    try {
      const result = await attemptsApi.getGitLog(workspaceId, repoId);
      if (requestIdRef.current === id) {
        setLogStatus(result);
        setError(null);
      }
    } catch (e) {
      if (requestIdRef.current === id) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (requestIdRef.current === id) {
        setIsLoading(false);
      }
    }
  }, [workspaceId, repoId]);

  useEffect(() => {
    if (!enabled || !workspaceId || !repoId) return;
    refresh();
  }, [enabled, workspaceId, repoId, refresh]);

  return {
    entries: logStatus?.entries ?? EMPTY_ENTRIES,
    total: logStatus?.total ?? 0,
    ahead: logStatus?.ahead ?? 0,
    behind: logStatus?.behind ?? 0,
    upstream: logStatus?.upstream ?? null,
    branchName: logStatus?.branch_name ?? '',
    isLoading,
    error,
    refresh,
  };
}
