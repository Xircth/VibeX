import { useState, useCallback, useRef, useLayoutEffect } from 'react';
import { Check, ChevronDown, Clipboard, Pencil, Undo2 } from 'lucide-react';
import WYSIWYGEditor, {
  SESSION_INPUT_MARKDOWN_PRESET,
  SESSION_INPUT_TEXT_CLASS_NAME,
} from '@/components/ui/wysiwyg';
import { BaseAgentCapability } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { useUserSystem } from '@/components/ConfigProvider';
import { useRetryUi } from '@/contexts/RetryUiContext';
import { useAttemptExecution } from '@/hooks/useAttemptExecution';
import { useBranchStatus } from '@/hooks/useBranchStatus';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { sessionsApi } from '@/lib/api';
import { RestoreLogsDialog } from '@/components/dialogs';
import { RetryEditorInline } from './RetryEditorInline';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import {
  getContinuityActionCopy,
  getExecutorContinuityMode,
} from '@/utils/sessionContinuity';
import { stripTagReferenceAppendix } from '@/lib/tagReferenceMarkers';

const COLLAPSED_MAX_HEIGHT = 120;
const EXPANDED_BOTTOM_SAFE_SPACE = 28;

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
  const [isCollapseMeasured, setIsCollapseMeasured] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [copied, triggerCopied] = useTemporaryFlag(400);

  const { capabilities } = useUserSystem();
  const { activeRetryProcessId, setActiveRetryProcessId, isProcessGreyed } =
    useRetryUi();
  const { isAttemptRunning } = useAttemptExecution(taskAttempt?.id);
  const { data: branchStatus } = useBranchStatus(taskAttempt?.id);
  const continuityCopy = getContinuityActionCopy(
    getExecutorContinuityMode(taskAttempt?.session?.executor ?? null)
  );
  const displayContent = stripTagReferenceAppendix(content);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    const check = () => {
      setNeedsCollapse(element.scrollHeight > COLLAPSED_MAX_HEIGHT);
      setIsCollapseMeasured(true);
    };

    check();

    const resizeObserver = new ResizeObserver(() => {
      check();
    });

    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, [displayContent]);

  const canFork = !!(
    taskAttempt?.session?.executor &&
    capabilities?.[taskAttempt.session.executor]?.includes(
      BaseAgentCapability.SESSION_FORK
    )
  );

  const startRetry = useCallback(() => {
    if (!executionProcessId || !taskAttempt) return;
    setIsEditing(true);
    setActiveRetryProcessId(executionProcessId);
  }, [executionProcessId, setActiveRetryProcessId, taskAttempt]);

  const onCancelled = useCallback(() => {
    setIsEditing(false);
    setActiveRetryProcessId(null);
  }, [setActiveRetryProcessId]);

  const showRetryEditor =
    !!executionProcessId &&
    isEditing &&
    activeRetryProcessId === executionProcessId;
  const greyed =
    !!executionProcessId &&
    isProcessGreyed(executionProcessId) &&
    !showRetryEditor;

  const canRetry = !!executionProcessId && canFork && !isAttemptRunning;
  const showActionRail = displayContent.trim().length > 0 || canRetry;

  const handleCopy = useCallback(async () => {
    if (!displayContent) return;

    try {
      await writeClipboardViaBridge(displayContent.replace(/\\_/g, '_'));
      triggerCopied();
    } catch {
      // Ignore clipboard failures in embedded environments.
    }
  }, [displayContent, triggerCopied]);

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
          mode: 'reset',
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
    } catch (error) {
      console.error('Failed to rollback:', error);
    } finally {
      setIsRollingBack(false);
    }
  }, [branchStatus, executionProcessId, taskAttempt]);

  if (showRetryEditor && taskAttempt) {
    return (
      <div className="py-2 px-3">
        <div className="flex justify-end">
          <div className="conv-user-retry-panel">
            <RetryEditorInline
              attempt={taskAttempt}
              executionProcessId={executionProcessId}
              initialContent={displayContent}
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
                isCollapsed && needsCollapse
                  ? `${COLLAPSED_MAX_HEIGHT}px`
                  : undefined,
              paddingBottom:
                !isCollapsed && needsCollapse
                  ? `${EXPANDED_BOTTOM_SAFE_SPACE}px`
                  : undefined,
            }}
          >
            <WYSIWYGEditor
              value={displayContent}
              disabled
              className={SESSION_INPUT_TEXT_CLASS_NAME}
              markdownPreset={SESSION_INPUT_MARKDOWN_PRESET}
              taskAttemptId={taskAttempt?.id}
              hideReadOnlyActions
            />
            {isCollapseMeasured && needsCollapse && isCollapsed && (
              <div className="conv-user-collapsible-overlay" />
            )}
          </div>

          {isCollapseMeasured && needsCollapse && (
            <button
              className="conv-user-toggle"
              title={isCollapsed ? '查看完整消息' : '收起消息'}
              aria-label={isCollapsed ? '查看完整消息' : '收起消息'}
              onClick={() => setIsCollapsed((value) => !value)}
            >
              <ChevronDown
                className={`h-3 w-3 conv-user-toggle-icon ${!isCollapsed ? 'is-expanded' : ''}`}
              />
            </button>
          )}

          {showActionRail && (
            <div className="absolute right-full top-2 mr-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                onClick={handleCopy}
                className="p-1 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                title={copied ? 'Copied!' : 'Copy as Markdown'}
                aria-label={copied ? 'Copied!' : 'Copy as Markdown'}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <Clipboard className="h-3.5 w-3.5" />
                )}
              </button>
              {canRetry && (
                <button
                  onClick={startRetry}
                  className="p-1 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                  title={continuityCopy.retryLabel}
                  aria-label={continuityCopy.retryLabel}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
              {canRetry && (
                <button
                  onClick={handleRollback}
                  disabled={isRollingBack}
                  className="p-1 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                  title="回滚到此处"
                  aria-label="回滚到此处"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default UserMessage;
