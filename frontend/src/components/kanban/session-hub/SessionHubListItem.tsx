import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  Bot,
  Check,
  GitBranch,
  Loader2,
  MoreVertical,
  Pencil,
  Pin,
  RotateCcw,
  X,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { exportConversation } from '@/lib/exportConversation';
import { conversationApi } from '@/features/conversation/conversationApi';
import { useOptionalKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import type { ExecutorProfileId } from 'shared/types';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { ProductContextMenu } from '@/components/context-menu/ProductContextMenu';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { armRenameOpeningClick } from '@/lib/renameOpeningGuard';
import { sessionTitleIsCjk } from '@/lib/sessionTitle';
import { cn } from '@/lib/utils';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import {
  SessionCardHoverCard,
  useSessionCardHoverDetails,
} from './SessionCardHoverInfo';
import { buildSessionCardMenuItems } from './sessionCardMenu';
import {
  INFO_TEXT_CLASS,
  formatSessionInfoForCopy,
  formatTimeAgo,
  getExecutorDisplayName,
  sessionAttentionKind,
  sessionListAgentKey,
  type SessionMarker,
} from './utils';

interface SessionHubListItemProps {
  session: KanbanProjectSessionRecord;
  marker: SessionMarker | null;
  isDeleteMode: boolean;
  isSelected: boolean;
  onClick: () => void;
  onToggleSelect: () => void;
  onRenameSession?: (name: string | null) => void | Promise<void>;
  onDeleteSession?: () => void | Promise<void>;
  onPinSession?: (pinned: boolean) => void | Promise<void>;
  onArchiveSession?: () => void | Promise<void>;
  onRestoreFromArchive?: () => void | Promise<void>;
  displayMode?: 'default' | 'kanban-board' | 'canvas';
  dragging?: boolean;
  isOpening?: boolean;
}

export function SessionHubListItem({
  session,
  marker,
  isDeleteMode,
  isSelected,
  onClick,
  onToggleSelect,
  onRenameSession,
  onDeleteSession,
  onPinSession,
  onArchiveSession,
  onRestoreFromArchive,
  displayMode = 'default',
  dragging = false,
  isOpening = false,
}: SessionHubListItemProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const kanbanSessions = useOptionalKanbanSessionContext();
  const hoverDetails = useSessionCardHoverDetails(session, session.fullName);
  const agentKey = sessionListAgentKey(session);
  const isKanbanBoardMode = displayMode === 'kanban-board';
  const isCanvasMode = displayMode === 'canvas';
  const isPinned = Boolean(session.pinnedAt);
  const showRenameControls =
    !isDeleteMode && !isKanbanBoardMode && Boolean(onRenameSession);
  const branchHoverText = session.workspaceName || session.branch;
  const workspaceLabel = session.workspaceName || session.branch;

  const [isEditing, setIsEditing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const openingRenameRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const disarmRenameRef = useRef<(() => void) | null>(null);
  const [isForking, setIsForking] = useState(false);
  const [draftName, setDraftName] = useState(session.fullName);
  const [isHovered, setIsHovered] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const attention = sessionAttentionKind(session);
  const showCanvasActions =
    isCanvasMode &&
    !isEditing &&
    (Boolean(onArchiveSession) || showRenameControls);
  const showDefaultHoverActions =
    !isCanvasMode && !isKanbanBoardMode && !isDeleteMode && !isEditing;
  const isHoverActionsVisible = isHovered || Boolean(contextMenu);
  const showListAgent =
    !isCanvasMode && !isKanbanBoardMode && !isHoverActionsVisible && !isEditing;
  const agentBadge = (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'session-hub-card-agent pointer-events-none flex shrink-0 items-center text-muted-foreground',
            showListAgent && 'absolute right-3 top-1/2 z-[1] -translate-y-1/2'
          )}
        >
          {agentKey ? (
            <AgentIcon
              agent={agentKey as ExecutorProfileId['executor']}
              className="h-4 w-4"
            />
          ) : (
            <Bot className="h-4 w-4" />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>{getExecutorDisplayName(agentKey)}</TooltipContent>
    </Tooltip>
  );

  useEffect(() => {
    if (!isEditing) {
      setDraftName(session.fullName);
    }
  }, [isEditing, session.fullName]);

  useEffect(() => () => disarmRenameRef.current?.(), []);

  useEffect(() => {
    if (isDeleteMode && isEditing) {
      setIsEditing(false);
      setIsSubmitting(false);
      setDraftName(session.fullName);
    }
  }, [isDeleteMode, isEditing, session.fullName]);

  const submitRename = async () => {
    if (!onRenameSession || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onRenameSession(draftName.trim() || null);
      setIsEditing(false);
    } catch {
      // The caller reports the failure. Leave the draft in the field.
    } finally {
      setIsSubmitting(false);
    }
  };

  const cancelRename = () => {
    disarmRenameRef.current?.();
    disarmRenameRef.current = null;
    openingRenameRef.current = false;
    setDraftName(session.fullName);
    setIsEditing(false);
    setIsSubmitting(false);
  };

  const beginRename = () => {
    disarmRenameRef.current?.();
    setDraftName(session.fullName);
    setIsEditing(true);
    disarmRenameRef.current = armRenameOpeningClick({
      opening: openingRenameRef,
      focus: () => renameInputRef.current?.focus(),
    });
  };

  const handleRenameBlur = () => {
    if (openingRenameRef.current) return;
    void submitRename();
  };

  const handleForkSession = () => {
    if (isForking) return;
    setIsForking(true);
    void conversationApi
      .fork(session.id)
      .then((result) => {
        if (result.continuity === 'history_only') {
          toast.warning(
            t('hubListItem.forkHistoryOnly', {
              reason: result.continuityNote,
            })
          );
        } else {
          toast.success(t('hubListItem.forkSuccess'));
        }
        if (kanbanSessions?.placeForkedChild) {
          kanbanSessions.placeForkedChild(
            {
              sessionId: result.conversationId,
              workspaceId: session.workspace.id,
            },
            session.id
          );
        } else {
          kanbanSessions?.placeCreatedSession({
            sessionId: result.conversationId,
            workspaceId: session.workspace.id,
          });
        }
      })
      .catch((error) =>
        toast.error(t('hubListItem.forkFailed', { error: String(error) }))
      )
      .finally(() => {
        setIsForking(false);
      });
  };

  const menuItems = buildSessionCardMenuItems({
    session,
    t,
    onRestore: onRestoreFromArchive
      ? () => {
          void onRestoreFromArchive();
        }
      : undefined,
    restoreLabel: t('hubListItem.moveToSessionList'),
    onRename: onRenameSession ? beginRename : undefined,
    onCopySessionInfo: () => {
      void writeClipboardViaBridge(formatSessionInfoForCopy(session));
      toast.success(t('hubListItem.copiedSessionInfo'));
    },
    onCopySessionName: () => {
      void writeClipboardViaBridge(session.fullName);
      toast.success(t('hubListItem.copiedSessionName'));
    },
    onExportHtml: () => {
      void exportConversation(
        session.id,
        'html',
        session.name ?? session.fullName ?? t('hubListItem.sessionFallback')
      );
    },
    onExportMarkdown: () => {
      void exportConversation(
        session.id,
        'markdown',
        session.name ?? session.fullName ?? t('hubListItem.sessionFallback')
      );
    },
    onFork: handleForkSession,
    isForking,
    onDelete: onDeleteSession
      ? () => {
          void onDeleteSession();
        }
      : undefined,
  });

  const canvasActionButtons = showCanvasActions ? (
    <div className="nodrag z-[1] flex shrink-0 items-center gap-0.5">
      {onArchiveSession ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('hubListItem.archiveSession')}
              className="session-hub-card-action"
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={(event) => {
                event.stopPropagation();
                void onArchiveSession();
              }}
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('hubListItem.archiveSession')}</TooltipContent>
        </Tooltip>
      ) : null}

      {showRenameControls ? (
        <button
          type="button"
          aria-label={t('hubListItem.renameSession')}
          className="session-hub-card-action"
          onClick={(event) => {
            event.stopPropagation();
            setDraftName(session.fullName);
            setIsEditing(true);
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  ) : null;

  const defaultHoverButtons = showDefaultHoverActions ? (
    <div
      className={cn(
        'session-hub-card-actions absolute right-2 top-1/2 -translate-y-1/2 z-[2] flex items-center gap-1 transition-opacity',
        isHoverActionsVisible
          ? 'opacity-100'
          : 'pointer-events-none opacity-0 group-hover/session-card:pointer-events-auto group-hover/session-card:opacity-100'
      )}
    >
      <button
        type="button"
        aria-label={t('hubListItem.moreActions')}
        aria-haspopup="menu"
        aria-expanded={Boolean(contextMenu)}
        className={cn(
          'session-hub-card-action',
          Boolean(contextMenu) && 'is-active text-foreground'
        )}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          setContextMenu((current) =>
            current ? null : { x: rect.left, y: rect.bottom + 4 }
          );
        }}
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>

      {onRestoreFromArchive ? (
        <button
          type="button"
          aria-label={t('hubListItem.moveToSessionList')}
          className="session-hub-card-action"
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            void onRestoreFromArchive();
          }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      ) : (
        <>
          <button
            type="button"
            aria-label={
              isPinned
                ? t('hubListItem.unpinSession')
                : t('hubListItem.pinSession')
            }
            aria-pressed={isPinned}
            className={cn(
              'session-hub-card-action',
              isPinned && 'is-active text-primary'
            )}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              void onPinSession?.(!isPinned);
            }}
          >
            <Pin className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            aria-label={t('hubListItem.archiveSession')}
            className="session-hub-card-action"
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              void onArchiveSession?.();
            }}
          >
            <Archive className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  ) : null;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-busy={isOpening || undefined}
      data-basic-guide="kanban-session-item"
      data-session-id={session.id}
      onClick={onClick}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'session-hub-card group/session-card relative box-border flex w-full max-w-full min-w-0 items-start gap-2 overflow-hidden rounded-lg px-3 py-2 text-left transition-colors duration-150',
        isSelected && 'is-selected',
        dragging && 'opacity-95 ring-1 ring-primary/20'
      )}
    >
      <div
        className={cn(
          'absolute inset-y-2 left-0 w-1 rounded-r-full',
          marker?.hue ? marker.bar : (marker?.bar ?? 'bg-muted-foreground/35')
        )}
        style={
          marker?.hue ? { backgroundColor: `hsl(${marker.hue})` } : undefined
        }
      />

      {isDeleteMode ? (
        <div
          className="relative z-[1] pt-1"
          onClick={(event) => event.stopPropagation()}
        >
          <Checkbox checked={isSelected} onCheckedChange={onToggleSelect} />
        </div>
      ) : null}

      <div
        className={cn(
          'min-w-0 w-0 flex-1 overflow-hidden',
          !isDeleteMode && 'pl-2',
          showListAgent && 'pr-7'
        )}
      >
        <div
          className={cn(
            'flex min-w-0 items-center gap-1.5',
            showDefaultHoverActions && isHoverActionsVisible && 'pr-20'
          )}
        >
          {isEditing ? (
            <Input
              ref={renameInputRef}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onBlur={handleRenameBlur}
              onKeyDownCapture={(event) => {
                if (event.key === 'Escape') {
                  openingRenameRef.current = true;
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submitRename();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelRename();
                }
              }}
              className="h-7 min-w-0 flex-1 rounded-md border-border/60 bg-[var(--surface-control)] text-xs"
              autoFocus
              disabled={isSubmitting}
            />
          ) : (
            <SessionCardHoverCard details={hoverDetails}>
              <div
                className={cn(
                  'session-hub-card-title min-w-0 flex-1 truncate text-[13px] text-foreground',
                  sessionTitleIsCjk(session.fullName)
                    ? 'font-normal'
                    : 'font-semibold'
                )}
              >
                {session.fullName}
              </div>
            </SessionCardHoverCard>
          )}

          {isEditing ? (
            <>
              <button
                type="button"
                className="composer-control shrink-0 rounded-md p-1 transition-colors"
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  void submitRename();
                }}
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="composer-control shrink-0 rounded-md p-1 transition-colors"
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  cancelRename();
                }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : null}

          {!isEditing && isPinned && !isKanbanBoardMode ? (
            <Pin
              data-testid="session-pinned-indicator"
              className="h-3 w-3 shrink-0 text-primary"
            />
          ) : null}

          {isOpening ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
          ) : null}

          {isCanvasMode && !isEditing ? agentBadge : null}
        </div>

        {!isEditing ? (
          <div
            className={cn(
              'mt-0.5 flex min-w-0 max-w-full items-center gap-x-1.5 text-[10px] text-muted-foreground',
              isCanvasMode ? 'gap-1' : 'flex-wrap gap-y-1'
            )}
          >
            <span className={cn('shrink-0 font-medium', INFO_TEXT_CLASS)}>
              {formatTimeAgo(session.updatedAt)}
            </span>
            <span className="shrink-0 text-muted-foreground/50">·</span>
            <span
              className="flex min-w-0 flex-1 items-center gap-1"
              title={isCanvasMode ? workspaceLabel : branchHoverText}
            >
              <GitBranch className="h-3 w-3 shrink-0 opacity-80" />
              <span className="min-w-0 truncate">
                {isCanvasMode ? workspaceLabel : session.branch}
              </span>
            </span>
            {isCanvasMode && attention === 'running' ? (
              <span className="session-status-running-pill shrink-0 rounded-full px-1.5 py-0.5 text-[10px]">
                {t('hubListItem.running')}
              </span>
            ) : isCanvasMode && attention === 'review' ? (
              <span className="session-status-inreview-pill shrink-0 rounded-full px-1.5 py-0.5 text-[10px]">
                {t('hubListItem.reviewing')}
              </span>
            ) : null}
            {isCanvasMode && showCanvasActions ? canvasActionButtons : null}
          </div>
        ) : null}
      </div>

      {showListAgent ? agentBadge : null}

      {defaultHoverButtons}
      {contextMenu ? (
        <ProductContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}
