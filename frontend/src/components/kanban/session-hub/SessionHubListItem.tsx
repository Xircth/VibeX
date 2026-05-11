import { useEffect, useState } from 'react';
import {
  Bot,
  Check,
  GitBranch,
  Loader2,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
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
  displayMode?: 'default' | 'kanban-board';
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
  displayMode = 'default',
  dragging = false,
  isOpening = false,
}: SessionHubListItemProps) {
  const isKanbanBoardMode = displayMode === 'kanban-board';
  const showRenameControls = !isDeleteMode && !isKanbanBoardMode;
  const branchHoverText = session.workspaceName || session.branch;
  const previewText = (session.firstPrompt ?? session.taskTitle ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  const [isEditing, setIsEditing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [draftName, setDraftName] = useState(session.fullName);
  const [isHovered, setIsHovered] = useState(false);

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

  return (
    <div
      role="button"
      tabIndex={0}
      aria-busy={isOpening || undefined}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'session-hub-card relative box-border flex w-full max-w-full min-w-0 items-start gap-2 overflow-hidden rounded-xl px-3 py-2 text-left transition-all duration-200',
        isSelected && 'is-selected',
        dragging &&
          'scale-[1.01] rotate-[0.75deg] shadow-xl ring-1 ring-primary/20'
      )}
    >
      <div
        className={cn(
          'absolute inset-y-2 left-0 w-1 rounded-r-full',
          marker?.bar ?? 'bg-muted-foreground/35'
        )}
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
        <div className="flex w-full min-w-0 items-start gap-2">
          <div className="min-w-0 w-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 items-center gap-2">
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
                  className="h-7 min-w-0 rounded-md border-border/60 bg-background/80 text-xs"
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
            </div>

            {!isEditing ? (
              <div className="mt-0.5 flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-muted-foreground">
                <span className={cn('shrink-0 font-medium', INFO_TEXT_CLASS)}>
                  {formatTimeAgo(session.updatedAt)}
                </span>
                <span className="shrink-0 text-muted-foreground/50">·</span>
                <span
                  className="flex min-w-0 max-w-full items-center gap-1"
                  title={branchHoverText}
                >
                  <GitBranch className="h-3 w-3 shrink-0 opacity-80" />
                  <span className="min-w-0 truncate">{session.branch}</span>
                </span>
                {session.isRunning ? (
                  <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                    运行中
                  </span>
                ) : null}
              </div>
            ) : null}

            {previewText ? (
              <p
                className="mt-0.5 block min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-muted-foreground"
                title={previewText}
              >
                {previewText}
              </p>
            ) : null}
          </div>

          {!isKanbanBoardMode || onDeleteSession ? (
            <div className="flex shrink-0 items-center gap-1">
              {onDeleteSession && !isEditing ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'composer-control rounded-md p-1 text-muted-foreground transition-opacity hover:text-foreground',
                        isHovered ? 'opacity-100' : 'opacity-0'
                      )}
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
                  <TooltipContent>删除会话</TooltipContent>
                </Tooltip>
              ) : null}

              {showRenameControls ? (
                isEditing ? (
                  <>
                    <button
                      type="button"
                      className="composer-control rounded-md p-1 transition-colors"
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
                      className="composer-control rounded-md p-1 transition-colors"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.stopPropagation();
                        cancelRename();
                      }}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={cn(
                      'composer-control rounded-md p-1 transition-opacity',
                      isHovered ? 'opacity-100' : 'opacity-0'
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      setDraftName(session.fullName);
                      setIsEditing(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )
              ) : null}

              {isOpening ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              ) : null}

              {!isKanbanBoardMode ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center justify-center text-muted-foreground">
                      {session.executor ? (
                        <AgentIcon
                          agent={
                            session.executor as ExecutorProfileId['executor']
                          }
                          className="h-4 w-4"
                        />
                      ) : (
                        <Bot className="h-4 w-4" />
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    {getExecutorDisplayName(session.executor)}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
