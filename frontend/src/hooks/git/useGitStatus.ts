import { useCallback, useEffect, useRef, useState } from 'react';
import { attemptsApi } from '@/lib/api';
import type { DetailedGitStatus, GitFileStatusEntry } from 'shared/types';

type PollMode = 'active' | 'background' | 'paused';

interface UseGitStatusOptions {
  workspaceId: string | null;
  repoId: string | null;
  pollMode?: PollMode;
}

interface UseGitStatusReturn {
  branchName: string;
  stagedFiles: GitFileStatusEntry[];
  unstagedFiles: GitFileStatusEntry[];
  totalAdditions: number;
  totalDeletions: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const EMPTY_FILES: GitFileStatusEntry[] = [];

function getPollInterval(mode: PollMode, fileCount: number): number {
  if (mode === 'paused') return 0;
  const isLarge = fileCount >= 120;
  if (mode === 'active') return isLarge ? 12000 : 3000;
  return isLarge ? 60000 : 30000;
}

export function useGitStatus({
  workspaceId,
  repoId,
  pollMode = 'active',
}: UseGitStatusOptions): UseGitStatusReturn {
  const [status, setStatus] = useState<DetailedGitStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!workspaceId || !repoId) return;

    const id = ++requestIdRef.current;
    setIsLoading(true);
    try {
      const result = await attemptsApi.getGitStatus(workspaceId, repoId);
      if (requestIdRef.current === id) {
        setStatus(result);
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
    if (!workspaceId || !repoId) {
      setStatus(null);
      return;
    }

    fetchStatus();

    const fileCount = (status?.staged_files.length ?? 0) + (status?.unstaged_files.length ?? 0);
    const interval = getPollInterval(pollMode, fileCount);

    if (interval > 0) {
      const tick = () => {
        fetchStatus();
        timerRef.current = setTimeout(tick, interval);
      };
      timerRef.current = setTimeout(tick, interval);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [workspaceId, repoId, pollMode, fetchStatus, status?.staged_files.length, status?.unstaged_files.length]);

  // Reset when workspace changes
  useEffect(() => {
    return () => {
      requestIdRef.current++;
    };
  }, [workspaceId, repoId]);

  return {
    branchName: status?.branch_name ?? '',
    stagedFiles: status?.staged_files ?? EMPTY_FILES,
    unstagedFiles: status?.unstaged_files ?? EMPTY_FILES,
    totalAdditions: status?.total_additions ?? 0,
    totalDeletions: status?.total_deletions ?? 0,
    isLoading,
    error,
    refresh: fetchStatus,
  };
}
