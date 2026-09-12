import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatMessage, ChatMessageBubble } from '@astryxdesign/core/Chat';
import { Check, ChevronDown, Clipboard, Pencil, Undo2 } from 'lucide-react';
import { UserMessageMarkdown } from './UserMessageMarkdown';
import { UserMessageAttachments } from './UserMessageImageAttachment';
import { splitDisplayContentImages } from './userMessageImages';
import { AgentCapability } from '@/lib/api/config';
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

const SESSION_INPUT_TEXT_CLASS_NAME =
  'break-words overflow-wrap-anywhere leading-5 tracking-[0.005em]';
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
  const { t } = useTranslation(['conversation', 'common']);
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
  const { text: displayText, images: displayImages } = useMemo(
    () => splitDisplayContentImages(displayContent),
    [displayContent]
  );
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
  }, [displayText]);

  const canResetToHere = !!(
    taskAttempt?.session?.executor &&
    capabilities?.[taskAttempt.session.executor]?.includes(
      AgentCapability.RESET_TO_HERE
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

  const canRetry = !!executionProcessId && canResetToHere && !isAttemptRunning;
  const showActionRail = displayContent.trim().length > 0 || canRetry;
  const hasTextBubble = displayText.trim().length > 0;

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
        <div className="flex w-full max-w-full flex-col items-end gap-1.5">
          <UserMessageAttachments
            images={displayImages}
            taskAttemptId={taskAttempt?.id}
          />

          {hasTextBubble && (
            <div className="conv-user-bubble-wrap">
              {showActionRail && (
                <div className="conv-user-actions">
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="conv-user-action-btn"
                    title={copied ? 'Copied!' : 'Copy as Markdown'}
                    aria-label={copied ? 'Copied!' : 'Copy as Markdown'}
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-[hsl(var(--success))]" />
                    ) : (
                      <Clipboard className="h-3 w-3" />
                    )}
                  </button>
                  {canRetry && (
                    <button
                      type="button"
                      onClick={startRetry}
                      className="conv-user-action-btn"
                      title={continuityCopy.retryLabel}
                      aria-label={continuityCopy.retryLabel}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                  {canRetry && (
                    <button
                      type="button"
                      onClick={handleRollback}
                      disabled={isRollingBack}
                      className="conv-user-action-btn"
                      title={t('userMessage.rollbackToHere')}
                      aria-label={t('userMessage.rollbackToHere')}
                    >
                      <Undo2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
              <ChatMessage
                sender="user"
                density="compact"
                className="vibex-user-message"
              >
                <ChatMessageBubble
                  className="conv-user-bubble relative"
                  data-testid="user-message-bubble"
                >
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
                    <UserMessageMarkdown
                      value={displayText}
                      className={SESSION_INPUT_TEXT_CLASS_NAME}
                      workspacePath={taskAttempt?.container_ref}
                    />
                    {isCollapseMeasured && needsCollapse && isCollapsed && (
                      <div className="conv-user-collapsible-overlay" />
                    )}
                  </div>

                  {isCollapseMeasured && needsCollapse && (
                    <button
                      className="conv-user-toggle"
                      title={
                        isCollapsed
                          ? t('userMessage.viewFullMessage')
                          : t('userMessage.collapseMessage')
                      }
                      aria-label={
                        isCollapsed
                          ? t('userMessage.viewFullMessage')
                          : t('userMessage.collapseMessage')
                      }
                      onClick={() => setIsCollapsed((value) => !value)}
                    >
                      <ChevronDown
                        className={`h-3 w-3 conv-user-toggle-icon ${!isCollapsed ? 'is-expanded' : ''}`}
                      />
                    </button>
                  )}
                </ChatMessageBubble>
              </ChatMessage>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default UserMessage;
