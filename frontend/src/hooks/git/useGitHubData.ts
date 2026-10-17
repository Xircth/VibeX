import { useCallback, useEffect, useState } from 'react';
import { repoApi } from '@/lib/api';
import type { GitHubIssueInfo, OpenPrInfo } from 'shared/types';

interface UseGitHubDataReturn {
  issues: GitHubIssueInfo[];
  prs: OpenPrInfo[];
  issuesLoading: boolean;
  prsLoading: boolean;
  issuesError: string | null;
  prsError: string | null;
  issueFilter: 'open' | 'closed' | 'all';
  setIssueFilter: (filter: 'open' | 'closed' | 'all') => void;
  refreshIssues: () => void;
  refreshPrs: () => void;
}

export function useGitHubData({
  repoId,
  enableIssues,
  enablePrs,
}: {
  repoId: string | null;
  enableIssues: boolean;
  enablePrs: boolean;
}): UseGitHubDataReturn {
  const [issues, setIssues] = useState<GitHubIssueInfo[]>([]);
  const [prs, setPrs] = useState<OpenPrInfo[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [prsLoading, setPrsLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [prsError, setPrsError] = useState<string | null>(null);
  const [issueFilter, setIssueFilter] = useState<'open' | 'closed' | 'all'>(
    'open'
  );

  const refreshIssues = useCallback(async () => {
    if (!repoId) return;
    setIssuesLoading(true);
    setIssuesError(null);
    try {
      const result = await repoApi.listRepoIssues(repoId, issueFilter);
      if (result.success) {
        setIssues(result.data);
      } else {
        const rawErr = result.error ?? result.message;
        const msg =
          typeof rawErr === 'string'
            ? rawErr
            : rawErr &&
                typeof rawErr === 'object' &&
                'message' in rawErr &&
                typeof (rawErr as { message?: unknown }).message === 'string'
              ? (rawErr as { message: string }).message
              : 'Failed to load issues';
        setIssuesError(msg);
      }
    } catch (e) {
      setIssuesError(e instanceof Error ? e.message : 'Failed to load issues');
    } finally {
      setIssuesLoading(false);
    }
  }, [repoId, issueFilter]);

  const refreshPrs = useCallback(async () => {
    if (!repoId) return;
    setPrsLoading(true);
    setPrsError(null);
    try {
      const result = await repoApi.listOpenPrs(repoId);
      if (result.success) {
        setPrs(result.data);
      } else {
        const rawErr = result.error ?? result.message;
        const msg =
          typeof rawErr === 'string'
            ? rawErr
            : rawErr &&
                typeof rawErr === 'object' &&
                'message' in rawErr &&
                typeof (rawErr as { message?: unknown }).message === 'string'
              ? (rawErr as { message: string }).message
              : 'Failed to load PRs';
        setPrsError(msg);
      }
    } catch (e) {
      setPrsError(e instanceof Error ? e.message : 'Failed to load PRs');
    } finally {
      setPrsLoading(false);
    }
  }, [repoId]);

  useEffect(() => {
    if (enableIssues && repoId) {
      refreshIssues();
    }
  }, [enableIssues, repoId, refreshIssues]);

  useEffect(() => {
    if (enablePrs && repoId) {
      refreshPrs();
    }
  }, [enablePrs, repoId, refreshPrs]);

  return {
    issues,
    prs,
    issuesLoading,
    prsLoading,
    issuesError,
    prsError,
    issueFilter,
    setIssueFilter,
    refreshIssues,
    refreshPrs,
  };
}
