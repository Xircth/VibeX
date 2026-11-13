import {
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  Bot,
  Check,
  MoreVertical,
  Pin,
  RotateCcw,
  X,
} from 'lucide-react';
import type { ExecutorProfileId } from 'shared/types';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { ProductContextMenu } from '@/components/context-menu/ProductContextMenu';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { conversationApi } from '@/features/conversation/conversationApi';
import { useOptionalKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { CollaborationSessionBadge } from '@/features/collaboration/CollaborationSessionBadge';
import { openCollaborationSessionFromList } from '@/features/collaboration/sessionCollaboration';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { exportConversation } from '@/lib/exportConversation';
import { armRenameOpeningClick } from '@/lib/renameOpeningGuard';
import { sessionTitleIsCjk } from '@/lib/sessionTitle';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/utils/date';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import {
  SessionCardHoverCard,
  useSessionCardHoverDetails,
} from '@/components/kanban/session-hub/SessionCardHoverInfo';
import { buildSessionCardMenuItems } from '@/components/kanban/session-hub/sessionCardMenu';
import {
  formatSessionInfoForCopy,
  getExecutorDisplayName,
  sessionListAgentKey,
  type SessionMarker,
} from '@/components/kanban/session-hub/utils';
import {
  formatCompactSessionAge,
  sessionListTitle,
  workspaceSessionStatusTone,
} from './workspaceSessionListModel';
import { SessionListAppearanceContext } from '@/lib/sessionListAppearance';

import {
  STATUS_LABEL_KEY,
  WorkspaceSessionStatusIndicator,
} from './WorkspaceSessionStatus';

export function WorkspaceSessionRow({
  session,
  isSelected,
  isDeleteMode = false,
  marker = null,
  showMarker = true,
  onClick,
  onToggleSelect,
  onPin,
  onArchive,
  onRename,
  onDelete,
  onRestore,
  overlay = false,
  setNodeRef,
  style,
  attributes,
  listeners,
  isDragging = false,
}: {
  session: KanbanProjectSessionRecord;
  isSelected: boolean;
  isDeleteMode?: boolean;
  marker?: SessionMarker | null;
  showMarker?: boolean;
  onClick: () => void;
  onToggleSelect?: () => void;
  onPin?: (pinned: boolean) => void;
  onArchive?: () => void;
  onRename?: (name: string | null) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  onRestore?: () => void;
  overlay?: boolean;
  setNodeRef?: (node: HTMLElement | null) => void;
  style?: CSSProperties;
  attributes?: HTMLAttributes<HTMLElement>;
  listeners?: HTMLAttributes<HTMLElement>;
  isDragging?: boolean;
}) {
  const { t } = useTranslation(['panels', 'tasks', 'common']);
  const appearance = useContext(SessionListAppearanceContext);
  const kanbanSessions = useOptionalKanbanSessionContext();
  const title = sessionListTitle(session);
  const hoverDetails = useSessionCardHoverDetails(session, title);
  const tone = workspaceSessionStatusTone(session);
  const statusLabel = t(STATUS_LABEL_KEY[tone]);
  const agentKey = sessionListAgentKey(session);
  const agentName = getExecutorDisplayName(agentKey);
  const compactAge = session.updatedAt
    ? formatCompactSessionAge(session.updatedAt)
    : '';
  const isPinned = Boolean(session.pinnedAt);
  const [isHovered, setIsHovered] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const openingRenameRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const disarmRenameRef = useRef<(() => void) | null>(null);
  const [isForking, setIsForking] = useState(false);
  const [draftName, setDraftName] = useState(title);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const showRowActions = !isDeleteMode && !overlay;
  const isRowHovered = (isHovered || Boolean(contextMenu)) && !isEditing;
  const markerElement = showMarker ? (
    <span
      className={cn(
        'workspace-session-row-marker',
        marker?.bar ?? 'bg-muted-foreground/35'
      )}
      style={
        marker?.hue ? { backgroundColor: `hsl(${marker.hue})` } : undefined
      }
      aria-hidden="true"
    />
  ) : null;

  useEffect(() => {
    if (!isEditing) {
      setDraftName(title);
    }
  }, [isEditing, title]);

  useEffect(() => () => disarmRenameRef.current?.(), []);

  const submitRename = async () => {
    if (!onRename || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onRename(draftName.trim() || null);
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
    setDraftName(title);
    setIsEditing(false);
    setIsSubmitting(false);
  };

  const beginRename = () => {
    disarmRenameRef.current?.();
    setDraftName(title);
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
            t('tasks:hubListItem.forkHistoryOnly', {
              reason: result.continuityNote,
            })
          );
        } else {
          toast.success(t('tasks:hubListItem.forkSuccess'));
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
        toast.error(
          t('tasks:hubListItem.forkFailed', {
            error: String(error),
          })
        )
      )
      .finally(() => {
        setIsForking(false);
      });
  };

  const menuItems = buildSessionCardMenuItems({
    session,
    t,
    onRestore,
    restoreLabel: t('workspaceSessionList.restore'),
    onRename: onRename ? beginRename : undefined,
    onCopySessionInfo: () => {
      void writeClipboardViaBridge(
        formatSessionInfoForCopy({
          ...session,
          fullName: title,
        })
      );
      toast.success(t('tasks:hubListItem.copiedSessionInfo'));
    },
    onCopySessionName: () => {
      void writeClipboardViaBridge(title);
      toast.success(t('tasks:hubListItem.copiedSessionName'));
    },
    onExportHtml: () => {
      void exportConversation(
        session.id,
        'html',
        session.name ?? title ?? t('tasks:hubListItem.sessionFallback')
      );
    },
    onExportMarkdown: () => {
      void exportConversation(
        session.id,
        'markdown',
        session.name ?? title ?? t('tasks:hubListItem.sessionFallback')
      );
    },
    onFork: handleForkSession,
    isForking,
    onDelete: onDelete
      ? () => {
          void onDelete();
        }
      : undefined,
  });

  return (
    <div
      role="listitem"
      ref={setNodeRef}
      className="max-w-full min-w-0"
      style={style}
    >
      <div
        className={cn(
          'workspace-session-row',
          appearance === 'full' && 'workspace-session-row--full',
          isSelected && 'is-selected',
          isDragging && 'is-dragging',
          overlay && 'is-overlay',
          isDeleteMode && 'is-delete-mode',
          isRowHovered && 'is-hovered'
        )}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onContextMenu={(event) => {
          if (isDeleteMode) return;
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {appearance === 'compact' ? markerElement : null}
        {isDeleteMode ? (
          <div
            className="flex shrink-0 items-center pl-1.5"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggleSelect?.()}
            />
          </div>
        ) : null}
        {isEditing ? (
          <div className="workspace-session-row-main is-editing">
            <span className="workspace-session-icon" aria-hidden="true">
              {agentKey ? (
                <AgentIcon
                  agent={agentKey as ExecutorProfileId['executor']}
                  className="h-4 w-4"
                />
              ) : (
                <Bot className="h-4 w-4 text-muted-foreground" />
              )}
            </span>
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
            <button
              type="button"
              className="workspace-session-row-action"
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
              className="workspace-session-row-action"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                cancelRename();
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <>
            <SessionCardHoverCard details={hoverDetails} enabled={!overlay}>
              <button
                type="button"
                aria-current={isSelected ? 'true' : undefined}
                aria-label={
                  session.isRunning
                    ? `${title}, ${agentName}, ${statusLabel}, ${t('workspaceSessionList.statusRunning')}`
                    : `${title}, ${agentName}, ${statusLabel}`
                }
                onClick={onClick}
                className={cn(
                  'workspace-session-row-main',
                  !listeners && !isEditing && 'cursor-pointer touch-auto'
                )}
                {...(overlay ? {} : attributes)}
                {...(overlay ? {} : listeners)}
              >
                <span className="workspace-session-icon" aria-hidden="true">
                  {agentKey ? (
                    <AgentIcon
                      agent={agentKey as ExecutorProfileId['executor']}
                      className="h-4 w-4"
                    />
                  ) : (
                    <Bot className="h-4 w-4 text-muted-foreground" />
                  )}
                </span>
                {appearance === 'full' ? (
                  <span className="workspace-session-card-content">
                    <span
                      className={cn(
                        'workspace-session-card-title',
                        sessionTitleIsCjk(title) && 'is-cjk'
                      )}
                    >
                      {title}
                      {isPinned ? (
                        <Pin
                          className="ml-1 inline h-3 w-3 text-primary"
                          aria-hidden="true"
                        />
                      ) : null}
                    </span>
                    <span className="workspace-session-card-workspace">
                      {markerElement}
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={hoverDetails.path || hoverDetails.workspaceLabel}
                      >
                        {hoverDetails.workspaceLabel}
                      </span>
                    </span>
                  </span>
                ) : (
                  <>
                    <span
                      className={cn(
                        'workspace-session-title',
                        sessionTitleIsCjk(title) && 'is-cjk'
                      )}
                    >
                      {title}
                    </span>
                    {isPinned ? (
                      <Pin
                        data-testid="workspace-session-pinned-indicator"
                        className="h-3 w-3 shrink-0 text-primary"
                      />
                    ) : null}
                    <span className="workspace-session-meta-idle gap-1.5">
                      {session.collaboration ? (
                        <CollaborationSessionBadge
                          memberName={session.collaboration.memberName}
                          conversationId={session.id}
                          onOpen={() => {
                            const collaboration = session.collaboration;
                            if (!collaboration) return;
                            openCollaborationSessionFromList({
                              conversationId: session.id,
                              collaboration,
                            });
                          }}
                        />
                      ) : null}
                      <WorkspaceSessionStatusIndicator
                        tone={tone}
                        className="workspace-session-row-status"
                      />
                      {compactAge ? (
                        <span
                          className="workspace-session-age"
                          title={formatRelativeTime(session.updatedAt)}
                        >
                          {compactAge}
                        </span>
                      ) : null}
                    </span>
                  </>
                )}
              </button>
            </SessionCardHoverCard>
            {showRowActions ? (
              <span className="workspace-session-row-actions">
                <button
                  type="button"
                  className={cn(
                    'workspace-session-row-action',
                    Boolean(contextMenu) && 'is-active'
                  )}
                  aria-label={t('tasks:hubListItem.moreActions')}
                  aria-haspopup="menu"
                  aria-expanded={Boolean(contextMenu)}
                  onPointerDown={(event) => event.stopPropagation()}
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
                {onRestore ? (
                  <button
                    type="button"
                    className="workspace-session-row-action"
                    aria-label={t('workspaceSessionList.restore')}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRestore();
                    }}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <>
                    {onPin ? (
                      <button
                        type="button"
                        className={cn(
                          'workspace-session-row-action',
                          isPinned && 'is-active'
                        )}
                        aria-label={
                          isPinned
                            ? t('workspaceSessionList.unpin')
                            : t('workspaceSessionList.pin')
                        }
                        aria-pressed={isPinned}
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          onPin(!isPinned);
                        }}
                      >
                        <Pin className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                    {onArchive ? (
                      <button
                        type="button"
                        className="workspace-session-row-action"
                        aria-label={t('workspaceSessionList.archive')}
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          onArchive();
                        }}
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </>
                )}
              </span>
            ) : null}
          </>
        )}
      </div>
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
