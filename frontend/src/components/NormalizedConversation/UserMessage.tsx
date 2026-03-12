import { useState, useCallback } from 'react';
import { Undo2 } from 'lucide-react';
import WYSIWYGEditor from '@/components/ui/wysiwyg';
import { BaseAgentCapability } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { useUserSystem } from '@/components/ConfigProvider';
import { useRetryUi } from '@/contexts/RetryUiContext';
import { useAttemptExecution } from '@/hooks/useAttemptExecution';
import { useBranchStatus } from '@/hooks/useBranchStatus';
import { sessionsApi } from '@/lib/api';
import { RestoreLogsDialog } from '@/components/dialogs';
import { RetryEditorInline } from './RetryEditorInline';

const UserMessage = ({
  content,
  executionProcessId,
  taskAttempt,
}: {
  content: string;
  executionProcessId?: string;
  taskAttempt?: WorkspaceWithSession;
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const { capabilities } = useUserSystem();
  const { activeRetryProcessId, setActiveRetryProcessId, isProcessGreyed } =
    useRetryUi();
  const { isAttemptRunning } = useAttemptExecution(taskAttempt?.id);
  const { data: branchStatus } = useBranchStatus(taskAttempt?.id);

  const canFork = !!(
    taskAttempt?.session?.executor &&
    capabilities?.[taskAttempt.session.executor]?.includes(
      BaseAgentCapability.SESSION_FORK
    )
  );

  const startRetry = () => {
    if (!executionProcessId || !taskAttempt) return;
    setIsEditing(true);
    setActiveRetryProcessId(executionProcessId);
  };

  const onCancelled = () => {
    setIsEditing(false);
    setActiveRetryProcessId(null);
  };

  const showRetryEditor =
    !!executionProcessId &&
    isEditing &&
    activeRetryProcessId === executionProcessId;
  const greyed =
    !!executionProcessId &&
    isProcessGreyed(executionProcessId) &&
    !showRetryEditor;

  // Only show retry button when allowed (has process, can fork, not running)
  const canRetry = executionProcessId && canFork && !isAttemptRunning;

  const handleRollback = useCallback(async () => {
    if (!executionProcessId || !taskAttempt?.session?.id) return;
    setIsRollingBack(true);
    try {
      let modalResult;
      try {
        modalResult = await RestoreLogsDialog.show({
          executionProcessId,
          branchStatus,
          processes: [],
        });
      } catch {
        return; // Dialog cancelled
      }
      if (!modalResult || modalResult.action !== 'confirmed') return;
      await sessionsApi.reset(taskAttempt.session.id, {
        process_id: executionProcessId,
        force_when_dirty: modalResult.forceWhenDirty ?? false,
        perform_git_reset: modalResult.performGitReset ?? true,
      });
    } catch (err) {
      console.error('Failed to rollback:', err);
    } finally {
      setIsRollingBack(false);
    }
  }, [executionProcessId, taskAttempt, branchStatus]);

  return (
    <div
      className={`py-2 px-3 ${greyed ? 'opacity-50 pointer-events-none' : ''}`}
    >
      <div className="rounded-lg border border-foreground/20 bg-background px-4 py-3 text-sm">
        {showRetryEditor && taskAttempt ? (
          <RetryEditorInline
            attempt={taskAttempt}
            executionProcessId={executionProcessId}
            initialContent={content}
            onCancelled={onCancelled}
          />
        ) : (
          <div className="relative group">
            <WYSIWYGEditor
              value={content}
              disabled
              className="whitespace-pre-wrap break-words flex flex-col gap-1"
              taskAttemptId={taskAttempt?.id}
              onEdit={canRetry ? startRetry : undefined}
            />
            {canRetry && (
              <button
                onClick={handleRollback}
                disabled={isRollingBack}
                className="absolute bottom-0 right-8 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                title="回退到此消息（不重新发送）"
                aria-label="回退"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default UserMessage;
