import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { CodexGoalState, CodexGoalStatus } from '@/lib/codexGoalState';

interface CodexGoalIndicatorProps {
  goalState: CodexGoalState | null;
}

const STATUS_LABELS: Record<CodexGoalStatus, string> = {
  running: '\u8fd0\u884c\u4e2d',
  paused: '\u5df2\u6682\u505c',
  completed: '\u5df2\u5b8c\u6210',
};

const STATUS_CLASSES: Record<CodexGoalStatus, string> = {
  running: 'bg-[hsl(var(--success))]',
  paused: 'bg-[hsl(var(--warning))]',
  completed: 'bg-muted-foreground',
};

export function CodexGoalIndicator({ goalState }: CodexGoalIndicatorProps) {
  if (!goalState) return null;

  const statusLabel = STATUS_LABELS[goalState.status];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="composer-control inline-flex max-w-[220px] cursor-default items-center gap-1.5 rounded-md px-2 py-0.5">
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {'\u76ee\u6807'}
          </span>
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              STATUS_CLASSES[goalState.status]
            )}
            aria-hidden="true"
          />
          <span className="shrink-0 text-[11px]">{statusLabel}</span>
          <span className="truncate text-[11px] text-muted-foreground">
            {goalState.objective}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="max-w-80 space-y-1">
          <div>
            {'\u72b6\u6001'}
            {': '}
            {statusLabel}
          </div>
          <div className="break-words">
            {'\u5f53\u524d\u76ee\u6807'}
            {': '}
            {goalState.objective}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
