import { useState, useCallback, useRef, useEffect } from 'react';
import { ChevronDown, Undo2 } from 'lucide-react';
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

const COLLAPSED_MAX_HEIGHT = 120; // px – roughly 6 lines at 14px/1.5

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
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const { capabilities } = useUserSystem();
  const { activeRetryProcessId, setActiveRetryProcessId, isProcessGreyed } =
    useRetryUi();
  const { isAttemptRunning } = useAttemptExecution(taskAttempt?.id);
  const { data: branchStatus } = useBranchStatus(taskAttempt?.id);

  // Check if content is tall enough to need collapsing
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const check = () => setNeedsCollapse(el.scrollHeight > COLLAPSED_MAX_HEIGHT + 20);
    check();
    // Re-check after WYSIWYG renders
    const timer = setTimeout(check, 200);
    return () => clearTimeout(timer);
  }, [content]);

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
        return;
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

  if (showRetryEditor && taskAttempt) {
    return (
      <div className="py-2 px-3">
        <div className="flex justify-end">
          <div className="conv-user-bubble max-w-[85%]">
            <RetryEditorInline
              attempt={taskAttempt}
              executionProcessId={executionProcessId}
              initialContent={content}
              onCancelled={onCancelled}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`py-1.5 px-3 ${greyed ? 'opacity-50 pointer-events-none' : ''}`}
    >
      <div className="flex justify-end group">
        <div className="conv-user-bubble relative">
          <div
            ref={contentRef}
            className="conv-user-collapsible"
            style={{
              maxHeight:
                needsCollapse && isCollapsed
                  ? `${COLLAPSED_MAX_HEIGHT}px`
                  : undefined,
            }}
          >
            <WYSIWYGEditor
              value={content}
              disabled
              className="whitespace-pre-wrap break-words flex flex-col gap-1"
              taskAttemptId={taskAttempt?.id}
              onEdit={canRetry ? startRetry : undefined}
            />
            {needsCollapse && isCollapsed && (
              <div className="conv-user-collapsible-overlay" />
            )}
          </div>

          {needsCollapse && (
            <button
              className="conv-user-toggle"
              onClick={() => setIsCollapsed((v) => !v)}
            >
              <ChevronDown
                className={`h-3 w-3 conv-user-toggle-icon ${!isCollapsed ? 'is-expanded' : ''}`}
              />
              <span>{isCollapsed ? '展开' : '收起'}</span>
            </button>
          )}

          {/* Hover actions – outside the bubble visually */}
          {canRetry && (
            <div className="absolute -left-8 top-1 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={handleRollback}
                disabled={isRollingBack}
                className="p-1 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                title="回退到此消息"
                aria-label="回退"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default UserMessage;
