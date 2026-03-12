import { useCallback, useState } from 'react';
import { attemptsApi } from '@/lib/api';

interface UseGitCommitOptions {
  workspaceId: string | null;
  repoId: string | null;
  onSuccess?: () => void;
}

interface UseGitCommitReturn {
  commitMessage: string;
  setCommitMessage: (msg: string) => void;
  commitLoading: boolean;
  pushLoading: boolean;
  pullLoading: boolean;
  fetchLoading: boolean;
  commitError: string | null;
  pushError: string | null;
  onCommit: () => Promise<void>;
  onCommitAndPush: () => Promise<void>;
  onPush: () => Promise<void>;
  onPull: () => Promise<void>;
  onFetch: () => Promise<void>;
}

export function useGitCommit({
  workspaceId,
  repoId,
  onSuccess,
}: UseGitCommitOptions): UseGitCommitReturn {
  const [commitMessage, setCommitMessage] = useState('');
  const [commitLoading, setCommitLoading] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [pullLoading, setPullLoading] = useState(false);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);

  const onCommit = useCallback(async () => {
    if (!workspaceId || !repoId || !commitMessage.trim()) return;

    setCommitLoading(true);
    setCommitError(null);
    try {
      await attemptsApi.commitChanges(workspaceId, repoId, commitMessage.trim());
      setCommitMessage('');
      onSuccess?.();
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitLoading(false);
    }
  }, [workspaceId, repoId, commitMessage, onSuccess]);

  const onCommitAndPush = useCallback(async () => {
    if (!workspaceId || !repoId || !commitMessage.trim()) return;

    setCommitLoading(true);
    setCommitError(null);
    setPushError(null);
    try {
      await attemptsApi.commitChanges(workspaceId, repoId, commitMessage.trim());
      setCommitMessage('');
      onSuccess?.();

      // Push after commit
      setPushLoading(true);
      const pushResult = await attemptsApi.push(workspaceId, { repo_id: repoId });
      if (!pushResult.success) {
        setPushError(`Push failed: ${pushResult.error?.type ?? 'unknown'}`);
      }
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitLoading(false);
      setPushLoading(false);
    }
  }, [workspaceId, repoId, commitMessage, onSuccess]);

  const onPush = useCallback(async () => {
    if (!workspaceId || !repoId) return;
    setPushLoading(true);
    setPushError(null);
    try {
      const pushResult = await attemptsApi.push(workspaceId, { repo_id: repoId });
      if (!pushResult.success) {
        setPushError(`Push failed: ${pushResult.error?.type ?? 'unknown'}`);
      }
      onSuccess?.();
    } catch (e) {
      setPushError(e instanceof Error ? e.message : String(e));
    } finally {
      setPushLoading(false);
    }
  }, [workspaceId, repoId, onSuccess]);

  const onPull = useCallback(async () => {
    if (!workspaceId || !repoId) return;
    setPullLoading(true);
    setPushError(null);
    try {
      const result = await attemptsApi.pullBranch(workspaceId, repoId);
      if (!result.success) {
        setPushError(`Pull failed: ${result.error ?? 'unknown'}`);
      }
      onSuccess?.();
    } catch (e) {
      setPushError(e instanceof Error ? e.message : String(e));
    } finally {
      setPullLoading(false);
    }
  }, [workspaceId, repoId, onSuccess]);

  const onFetch = useCallback(async () => {
    if (!workspaceId || !repoId) return;
    setFetchLoading(true);
    setPushError(null);
    try {
      await attemptsApi.fetchRemote(workspaceId, repoId);
      onSuccess?.();
    } catch (e) {
      setPushError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetchLoading(false);
    }
  }, [workspaceId, repoId, onSuccess]);

  return {
    commitMessage,
    setCommitMessage,
    commitLoading,
    pushLoading,
    pullLoading,
    fetchLoading,
    commitError,
    pushError,
    onCommit,
    onCommitAndPush,
    onPush,
    onPull,
    onFetch,
  };
}
