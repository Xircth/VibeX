import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { attemptsApi, repoApi } from '@/lib/api';
import type { GitFileDiffEntry, GitFileStatusEntry } from 'shared/types';

const LOCK_FILE_PATTERNS = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'Cargo.lock',
  'bun.lockb',
  'bun.lock',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
];

const SKIP_PATH_PATTERNS = [
  'node_modules/',
  '.next/',
  'dist/',
  'build/',
  '.cache/',
  'target/',
];

interface UseGitDiffsOptions {
  workspaceId: string | null;
  repoId: string | null;
}

interface UseGitDiffsReturn {
  diffs: GitFileDiffEntry[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function shouldAutoPreloadDiffs(
  stagedFiles: GitFileStatusEntry[],
  unstagedFiles: GitFileStatusEntry[]
): boolean {
  const allFiles = [...stagedFiles, ...unstagedFiles];
  if (allFiles.length > 80) return false;

  const hasLockFile = allFiles.some((f) =>
    LOCK_FILE_PATTERNS.some((p) => f.path.endsWith(p))
  );
  if (hasLockFile) return false;

  const hasSkipPath = allFiles.some((f) =>
    SKIP_PATH_PATTERNS.some((p) => f.path.includes(p))
  );
  if (hasSkipPath) return false;

  const totalChanges = allFiles.reduce(
    (sum, f) => sum + f.additions + f.deletions,
    0
  );
  if (totalChanges > 8000) return false;

  const hasLargeFile = allFiles.some((f) => f.additions + f.deletions > 3000);
  if (hasLargeFile) return false;

  return true;
}

export function useGitDiffs({
  workspaceId,
  repoId,
}: UseGitDiffsOptions): UseGitDiffsReturn {
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ['gitDiffs', workspaceId, repoId],
    [workspaceId, repoId]
  );

  const {
    data: diffs,
    isLoading,
    error: queryError,
  } = useQuery<GitFileDiffEntry[]>({
    queryKey,
    queryFn: async () => {
      return workspaceId
        ? await attemptsApi.getFileDiffs(workspaceId, repoId!)
        : await repoApi.getFileDiffs(repoId!);
    },
    enabled: !!repoId,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    diffs: diffs ?? [],
    isLoading,
    error: queryError
      ? queryError instanceof Error
        ? queryError.message
        : String(queryError)
      : null,
    refresh,
  };
}
