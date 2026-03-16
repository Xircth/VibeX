import { useCallback, useState } from 'react';
import { attemptsApi, repoApi } from '@/lib/api';

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
  operationError: string | null;
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
  const [operationError, setOperationError] = useState<string | null>(null);

  const onCommit = useCallback(async () => {
    if (!repoId || !commitMessage.trim()) return;

    setCommitLoading(true);
    setCommitError(null);
    try {
      if (workspaceId) {
        await attemptsApi.commitChanges(workspaceId, repoId, commitMessage.trim());
      } else {
        await repoApi.commitChanges(repoId, commitMessage.trim());
      }
      setCommitMessage('');
      onSuccess?.();
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitLoading(false);
    }
  }, [workspaceId, repoId, commitMessage, onSuccess]);

  const onCommitAndPush = useCallback(async () => {
    if (!repoId || !commitMessage.trim()) return;

    setCommitLoading(true);
    setCommitError(null);
    setOperationError(null);
    try {
      if (workspaceId) {
        await attemptsApi.commitChanges(workspaceId, repoId, commitMessage.trim());
      } else {
        await repoApi.commitChanges(repoId, commitMessage.trim());
      }
      setCommitMessage('');
      onSuccess?.();

      // Push after commit
      setPushLoading(true);
      if (workspaceId) {
        const pushResult = await attemptsApi.push(workspaceId, { repo_id: repoId });
        if (!pushResult.success) {
          setOperationError(`Push failed: ${pushResult.error?.type ?? 'unknown'}`);
        }
      } else {
        await repoApi.push(repoId);
      }
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitLoading(false);
      setPushLoading(false);
    }
  }, [workspaceId, repoId, commitMessage, onSuccess]);

  const onPush = useCallback(async () => {
    if (!repoId) return;
    setPushLoading(true);
    setOperationError(null);
    try {
      if (workspaceId) {
        const pushResult = await attemptsApi.push(workspaceId, { repo_id: repoId });
        if (!pushResult.success) {
          setOperationError(`Push failed: ${pushResult.error?.type ?? 'unknown'}`);
        }
      } else {
        await repoApi.push(repoId);
      }
      onSuccess?.();
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : String(e));
    } finally {
      setPushLoading(false);
    }
  }, [workspaceId, repoId, onSuccess]);

  const onPull = useCallback(async () => {
    if (!repoId) return;
    setPullLoading(true);
    setOperationError(null);
    try {
      if (workspaceId) {
        const result = await attemptsApi.pullBranch(workspaceId, repoId);
        if (!result.success) {
          setOperationError(`Pull failed: ${result.error ?? 'unknown'}`);
        }
      } else {
        const result = await repoApi.pull(repoId);
        if (!result.success) {
          setOperationError(`Pull failed: ${result.error ?? 'unknown'}`);
        }
      }
      onSuccess?.();
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : String(e));
    } finally {
      setPullLoading(false);
    }
  }, [workspaceId, repoId, onSuccess]);

  const onFetch = useCallback(async () => {
    if (!repoId) return;
    setFetchLoading(true);
    setOperationError(null);
    try {
      if (workspaceId) {
        await attemptsApi.fetchRemote(workspaceId, repoId);
      } else {
        await repoApi.fetch(repoId);
      }
      onSuccess?.();
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : String(e));
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
    operationError,
    onCommit,
    onCommitAndPush,
    onPush,
    onPull,
    onFetch,
  };
}
