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
  commitError: string | null;
  pushError: string | null;
  onCommit: () => Promise<void>;
  onCommitAndPush: () => Promise<void>;
}

export function useGitCommit({
  workspaceId,
  repoId,
  onSuccess,
}: UseGitCommitOptions): UseGitCommitReturn {
  const [commitMessage, setCommitMessage] = useState('');
  const [commitLoading, setCommitLoading] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
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

  return {
    commitMessage,
    setCommitMessage,
    commitLoading,
    pushLoading,
    commitError,
    pushError,
    onCommit,
    onCommitAndPush,
  };
}
