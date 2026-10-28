import { useCallback, useState } from 'react';
import {
  Activity,
  FileText,
  Loader2,
  PauseCircle,
  Square,
  Terminal,
  Workflow,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AsyncTaskRecord } from 'shared/types';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { liveAsyncTasks } from '@/lib/asyncTasks';
import { formatGoalTokens } from '@/lib/sessionGoal';

function AsyncTaskKindIcon({ task }: { task: AsyncTaskRecord }) {
  if (task.state === 'paused') {
    return (
      <PauseCircle
        className="h-3 w-3 shrink-0 text-[hsl(var(--warning))]"
        aria-hidden="true"
      />
    );
  }
  const kind = (task.task_type ?? '').toLowerCase();
  if (kind === 'shell' || kind === 'bash' || kind === 'terminal') {
    return (
      <Terminal
        className="h-3 w-3 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    );
  }
  if (kind === 'workflow') {
    return (
      <Workflow
        className="h-3 w-3 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    );
  }
  return (
    <Activity
      className="h-3 w-3 shrink-0 text-muted-foreground"
      aria-hidden="true"
    />
  );
}

export interface SessionAsyncTaskBarProps {
  tasks: readonly AsyncTaskRecord[];
  sessionBindReady?: boolean;
  onStopTask?: (taskId: string) => Promise<boolean>;
  onOpenOutputFile?: (filePath: string) => void;
  className?: string;
}

export function SessionAsyncTaskBar({
  tasks,
  sessionBindReady = true,
  onStopTask,
  onOpenOutputFile,
  className,
}: SessionAsyncTaskBarProps) {
  const { t } = useTranslation('conversation');
  const panelActions = useOptionalPanelActionsContext();
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());

  const live = liveAsyncTasks(tasks);

  const handleOpenOutput = useCallback(
    (filePath: string, taskName: string) => {
      if (onOpenOutputFile) {
        onOpenOutputFile(filePath);
        return;
      }
      panelActions?.openFilePreview(filePath, {
        displayPath: filePath,
        title: taskName,
      });
    },
    [onOpenOutputFile, panelActions]
  );

  const handleStop = useCallback(
    async (taskId: string) => {
      if (!onStopTask || stoppingIds.has(taskId)) return;
      setStoppingIds((prev) => {
        const next = new Set(prev);
        next.add(taskId);
        return next;
      });
      try {
        const stopped = await onStopTask(taskId);
        if (!stopped) {
          toast.error(t('asyncTasks.stopFailed'));
        }
      } catch {
        toast.error(t('asyncTasks.stopFailed'));
      } finally {
        setStoppingIds((prev) => {
          if (!prev.has(taskId)) return prev;
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }
    },
    [onStopTask, stoppingIds, t]
  );

  if (live.length === 0) {
    return null;
  }

  return (
    <div
      role="region"
      aria-label={t('asyncTasks.regionAria')}
      data-testid="session-async-task-bar"
      className={cn(
        'flex shrink-0 flex-col gap-1 overflow-hidden rounded-lg border border-border bg-[var(--surface-card,hsl(var(--card)))] p-1.5 text-xs',
        className
      )}
    >
      {live.map((task) => {
        const taskName = task.name?.trim() || t('asyncTasks.defaultName');
        const isStopping = stoppingIds.has(task.id);
        const canStop = Boolean(
          task.can_stop && sessionBindReady && onStopTask
        );
        const outputPath = task.output_file_path?.trim() || null;

        const metaParts: string[] = [];
        if (task.phase?.trim()) metaParts.push(task.phase.trim());
        if (task.current_agent?.trim()) {
          metaParts.push(task.current_agent.trim());
        }
        if (task.last_tool_name?.trim()) {
          metaParts.push(task.last_tool_name.trim());
        }
        const totalTokens = task.usage?.total_tokens;
        if (totalTokens != null && Number(totalTokens) >= 0) {
          metaParts.push(
            t('asyncTasks.tokensShort', {
              tokens: formatGoalTokens(Number(totalTokens)),
            })
          );
        }

        const dotClass =
          task.state === 'paused'
            ? 'bg-[hsl(var(--warning))]'
            : 'bg-[hsl(var(--success))]';

        return (
          <div
            key={task.id}
            data-testid={`async-task-row-${task.id}`}
            data-task-state={task.state}
            className="flex min-h-7 items-center justify-between gap-2.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted/35"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted/70 px-2 py-0.5 text-xs font-medium text-foreground/90">
                <AsyncTaskKindIcon task={task} />
                <span>{t('asyncTasks.backgroundBadge')}</span>
                <span
                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClass)}
                  aria-hidden="true"
                />
              </span>
              <span
                title={taskName}
                className="min-w-0 max-w-64 truncate font-medium text-foreground"
              >
                {taskName}
              </span>
              {metaParts.length > 0 ? (
                <span className="min-w-0 flex-1 truncate tabular-nums text-muted-foreground">
                  {metaParts.join(' · ')}
                </span>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {outputPath ? (
                <button
                  type="button"
                  data-testid={`session-async-task-output-${task.id}`}
                  onClick={() => handleOpenOutput(outputPath, taskName)}
                  aria-label={t('asyncTasks.openOutputAria', {
                    name: taskName,
                  })}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <FileText className="h-3 w-3" aria-hidden="true" />
                  <span>{t('asyncTasks.outputButton')}</span>
                </button>
              ) : null}
              {canStop ? (
                <button
                  type="button"
                  data-testid={`session-async-task-stop-${task.id}`}
                  aria-label={t('asyncTasks.stopAria', { name: taskName })}
                  title={t('asyncTasks.stopAria', { name: taskName })}
                  disabled={isStopping}
                  onClick={() => {
                    void handleStop(task.id);
                  }}
                  className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  {isStopping ? (
                    <Loader2
                      className="h-3 w-3 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Square className="h-3 w-3" aria-hidden="true" />
                  )}
                  <span>{t('asyncTasks.stop')}</span>
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
