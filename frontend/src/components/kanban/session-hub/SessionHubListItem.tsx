import { useEffect, useState } from 'react';
import { Bot, Check, GitBranch, Pencil, X } from 'lucide-react';
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
  displayMode?: 'default' | 'kanban-board';
  dragging?: boolean;
}

export function SessionHubListItem({
  session,
  marker,
  isDeleteMode,
  isSelected,
  onClick,
  onToggleSelect,
  onRenameSession,
  displayMode = 'default',
  dragging = false,
}: SessionHubListItemProps) {
  const isKanbanBoardMode = displayMode === 'kanban-board';
  const showRenameControls = !isDeleteMode && !isKanbanBoardMode;
  const branchHoverText = session.workspaceName || session.branch;
  const previewText = session.firstPrompt ?? session.taskTitle ?? '';

  const [isEditing, setIsEditing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [draftName, setDraftName] = useState(session.fullName);

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
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'group relative flex items-start gap-2 overflow-hidden rounded-lg border border-border bg-background px-3 py-2 text-left transition-all duration-200 hover:-translate-y-0.5 hover:bg-muted/40 hover:shadow-sm',
        isSelected && 'border-primary/50 bg-primary/5',
        dragging && 'shadow-lg'
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

      <div className={cn('min-w-0 flex-1', !isDeleteMode && 'pl-2')}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
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
                  className="h-7 min-w-0 rounded-sm border-border/60 bg-background text-xs"
                  autoFocus
                  disabled={isSubmitting}
                />
              ) : (
                <div
                  className="truncate text-[13px] font-semibold text-foreground"
                  title={session.fullName}
                >
                  {session.fullName}
                </div>
              )}
              {!isEditing ? (
                <div className="ml-auto flex max-w-[60%] shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span
                    className={cn('shrink-0 font-medium', INFO_TEXT_CLASS)}
                  >
                    {formatTimeAgo(session.updatedAt)}
                  </span>
                  <span className="shrink-0 text-muted-foreground/50">·</span>
                  <span
                    className="inline-flex min-w-0 items-center gap-1"
                    title={branchHoverText}
                  >
                    <GitBranch className="h-3 w-3 shrink-0 opacity-80" />
                    <span className="min-w-0 truncate">{session.branch}</span>
                  </span>
                </div>
              ) : null}
              {session.isRunning && !isEditing ? (
                <span className="ml-2 shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                  运行中
                </span>
              ) : null}
            </div>

            {previewText ? (
              <div className="mt-0.5 min-w-0">
                <span
                  className="block truncate text-[11px] text-muted-foreground"
                  title={previewText}
                >
                  {previewText}
                </span>
              </div>
            ) : null}
          </div>

          {!isKanbanBoardMode ? (
            <div className="flex shrink-0 items-center gap-1">
              {showRenameControls ? (
                isEditing ? (
                  <>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
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
                      className="text-muted-foreground hover:text-foreground"
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
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
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
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
