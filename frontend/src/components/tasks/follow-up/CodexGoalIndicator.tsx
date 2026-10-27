import { useTranslation } from 'react-i18next';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { CodexGoalState, CodexGoalStatus } from '@/lib/codexGoalState';

interface CodexGoalIndicatorProps {
  goalState: CodexGoalState | null;
  onClick?: () => void;
}

const STATUS_CLASSES: Record<CodexGoalStatus, string> = {
  running: 'bg-[hsl(var(--success))]',
  paused: 'bg-[hsl(var(--warning))]',
  limited: 'bg-[hsl(var(--warning))]',
  failed: 'bg-destructive',
  completed: 'bg-muted-foreground',
};

export function CodexGoalIndicator({
  goalState,
  onClick,
}: CodexGoalIndicatorProps) {
  const { t } = useTranslation(['conversation']);
  if (!goalState) return null;

  const statusLabel = t(`codexGoal.status.${goalState.status}`, {
    defaultValue: goalState.status,
  });

  const content = (
    <>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {t('codexGoal.label')}
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
    </>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onClick ? (
          <button
            type="button"
            onClick={onClick}
            className="composer-control inline-flex max-w-[220px] items-center gap-1.5 rounded-md px-2 py-0.5 transition-colors hover:bg-[var(--bg-hover)]"
          >
            {content}
          </button>
        ) : (
          <span className="composer-control inline-flex max-w-[220px] cursor-default items-center gap-1.5 rounded-md px-2 py-0.5">
            {content}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>
        <div className="max-w-80 space-y-1">
          <div>
            {t('codexGoal.statusLabel')}: {statusLabel}
          </div>
          <div className="break-words">
            {t('codexGoal.currentLabel')}: {goalState.objective}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
