import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Check,
  FileCode,
  FileDown,
  GitBranch,
  GitFork,
  Loader2,
  Pencil,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { exportConversation } from '@/lib/exportConversation';
import { conversationApi } from '@/features/conversation/conversationApi';
import type { ExecutorProfileId } from 'shared/types';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { cn } from '@/lib/utils';
import {
  INFO_TEXT_CLASS,
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
  onRestoreFromArchive,
  displayMode = 'default',
  dragging = false,
  isOpening = false,
}: SessionHubListItemProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const agentKey = sessionListAgentKey(session);
  const isKanbanBoardMode = displayMode === 'kanban-board';
  const isCanvasMode = displayMode === 'canvas';
  const showRenameControls =
    !isDeleteMode && !isKanbanBoardMode && Boolean(onRenameSession);
  const branchHoverText = session.workspaceName || session.branch;
  const workspaceLabel = session.workspaceName || session.branch;

  const [isEditing, setIsEditing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [draftName, setDraftName] = useState(session.fullName);
  const [isHovered, setIsHovered] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const attention = sessionAttentionKind(session);
  const showCardActions =
    !isEditing && (Boolean(onDeleteSession) || showRenameControls);

  useEffect(() => {
    if (!isEditing) {
      setDraftName(session.fullName);
    }
  }, [isEditing, session.fullName]);

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
    } finally {
      setIsSubmitting(false);
    }
  };

  const cancelRename = () => {
    setDraftName(session.fullName);
    setIsEditing(false);
    setIsSubmitting(false);
  };

  useEffect(() => {
    if (!contextMenu) return;

    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    window.addEventListener('keydown', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('keydown', closeMenu);
    };
  }, [contextMenu]);

  const actionButtons = showCardActions ? (
    <div
      className={cn(
        'z-[1] flex items-center gap-1',
        isCanvasMode
          ? 'nodrag shrink-0'
          : cn(
              'absolute bottom-1.5 right-1.5 transition-opacity',
              isHovered ? 'opacity-100' : 'pointer-events-none opacity-0'
            )
      )}
    >
      {onDeleteSession ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('hubListItem.deleteSession')}
              className="composer-control rounded-md p-1 text-muted-foreground hover:text-foreground"
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={(event) => {
                event.stopPropagation();
                void onDeleteSession();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('hubListItem.deleteSession')}</TooltipContent>
        </Tooltip>
      ) : null}

      {showRenameControls ? (
        <button
          type="button"
          aria-label={t('hubListItem.renameSession')}
          className="composer-control rounded-md p-1"
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

  return (
    <div
      role="button"
      tabIndex={0}
      aria-busy={isOpening || undefined}
      onClick={onClick}
      onContextMenu={(event) => {
        if (isCanvasMode) return;
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
        'session-hub-card relative box-border flex w-full max-w-full min-w-0 items-start gap-2 overflow-hidden rounded-lg px-3 py-2 text-left transition-colors duration-150',
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
          !isDeleteMode && 'pl-2'
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {isEditing ? (
            <Input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onBlur={() => void submitRename()}
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
            <div
              className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground"
              title={session.fullName}
            >
              {session.fullName}
            </div>
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

          {isOpening ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
          ) : null}

          {!isKanbanBoardMode ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex shrink-0 items-center justify-center text-muted-foreground">
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
              <TooltipContent>
                {getExecutorDisplayName(agentKey)}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>

        {!isEditing ? (
          <div
            className={cn(
              'mt-0.5 flex min-w-0 max-w-full items-center gap-x-1.5 text-[10px] text-muted-foreground',
              isCanvasMode ? 'gap-1' : 'flex-wrap gap-y-1',
              !isCanvasMode && isHovered && showCardActions && 'pr-12'
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
            {attention === 'running' ? (
              <span className="session-status-running-pill shrink-0 rounded-full px-1.5 py-0.5 text-[10px]">
                {t('hubListItem.running')}
              </span>
            ) : attention === 'review' ? (
              <span className="session-status-inreview-pill shrink-0 rounded-full px-1.5 py-0.5 text-[10px]">
                {t('hubListItem.reviewing')}
              </span>
            ) : null}
            {isCanvasMode && showCardActions ? actionButtons : null}
          </div>
        ) : null}
      </div>

      {!isCanvasMode && showCardActions ? actionButtons : null}
      {contextMenu ? (
        <div
          className="tahoe-popover fixed z-50 min-w-40 rounded-md p-1 text-popover-foreground"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.preventDefault()}
        >
          {onRestoreFromArchive ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                setContextMenu(null);
                void onRestoreFromArchive?.();
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t('hubListItem.moveToSessionList')}
            </button>
          ) : null}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              setContextMenu(null);
              void conversationApi
                .fork(session.id)
                .then((result) => {
                  if (result.continuity === 'history_only') {
                    toast.warning(
                      t('hubListItem.forkHistoryOnly', {
                        reason: result.continuityNote,
                      })
                    );
                    return;
                  }
                  toast.success(t('hubListItem.forkSuccess'));
                })
                .catch((error) =>
                  toast.error(
                    t('hubListItem.forkFailed', { error: String(error) })
                  )
                );
            }}
          >
            <GitFork className="h-3.5 w-3.5" />
            {t('hubListItem.forkSession')}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              setContextMenu(null);
              void exportConversation(
                session.id,
                'markdown',
                session.name ?? t('hubListItem.sessionFallback')
              );
            }}
          >
            <FileDown className="h-3.5 w-3.5" />
            {t('hubListItem.exportAsMarkdown')}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              setContextMenu(null);
              void exportConversation(
                session.id,
                'html',
                session.name ?? t('hubListItem.sessionFallback')
              );
            }}
          >
            <FileCode className="h-3.5 w-3.5" />
            {t('hubListItem.exportAsHtml')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
