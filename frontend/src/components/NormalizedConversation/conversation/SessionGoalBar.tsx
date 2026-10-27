import { useCallback, useState } from 'react';
import { Loader2, Pause, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationSessionGoal, GoalControlReceipt } from 'shared/types';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { getErrorMessage } from '@/lib/modals';
import {
  formatGoalDuration,
  formatGoalTokens,
  isLimitedGoalStatus,
  parseConversationSessionGoal,
  type SessionGoalStatus,
} from '@/lib/sessionGoal';

export function sessionGoalStatusDotClass(status: SessionGoalStatus): string {
  switch (status) {
    case 'active':
      return 'bg-[hsl(var(--success))]';
    case 'paused':
      return 'bg-amber-500';
    case 'failed':
      return 'bg-destructive';
    case 'completed':
      return 'bg-muted-foreground/60';
    default:
      return isLimitedGoalStatus(status)
        ? 'bg-destructive'
        : 'bg-muted-foreground/60';
  }
}

export interface SessionGoalBarProps {
  sessionGoal: ConversationSessionGoal | null;
  sessionBindReady?: boolean;
  onGoalControl?: (action: 'pause' | 'clear') => Promise<GoalControlReceipt>;
  onSelectGoal?: () => void;
  className?: string;
}

export function SessionGoalBar({
  sessionGoal,
  sessionBindReady = true,
  onGoalControl,
  onSelectGoal,
  className,
}: SessionGoalBarProps) {
  const { t } = useTranslation('conversation');
  const [pendingAction, setPendingAction] = useState<'pause' | 'clear' | null>(
    null
  );

  const parsed = parseConversationSessionGoal(sessionGoal, {
    sessionBindReady: sessionBindReady && Boolean(onGoalControl),
  });

  const handleAction = useCallback(
    async (action: 'pause' | 'clear') => {
      if (!onGoalControl || pendingAction !== null) return;
      setPendingAction(action);
      try {
        await onGoalControl(action);
      } catch (error) {
        toast.error(getErrorMessage(error));
      } finally {
        setPendingAction(null);
      }
    },
    [onGoalControl, pendingAction]
  );

  if (!parsed || !parsed.isLiveBarVisible) {
    return null;
  }

  const statusText =
    parsed.status === 'active'
      ? t('sessionGoal.status.active')
      : parsed.status === 'paused'
        ? t('sessionGoal.status.paused')
        : parsed.status === 'completed'
          ? t('sessionGoal.status.completed')
          : isLimitedGoalStatus(parsed.status)
            ? t('sessionGoal.status.limited')
            : t('sessionGoal.status.failed');

  const metaParts: string[] = [];
  if (parsed.status === 'active') {
    if (parsed.tokensUsed != null) {
      metaParts.push(
        t('sessionGoal.tokensUsedShort', {
          tokens: formatGoalTokens(parsed.tokensUsed),
        })
      );
    }
    if (parsed.durationMs != null) {
      metaParts.push(formatGoalDuration(parsed.durationMs));
    }
  }

  return (
    <div
      role="status"
      data-testid="session-goal-bar"
      data-goal-status={parsed.status}
      className={cn(
        'flex min-h-[34px] shrink-0 items-center justify-between gap-2 border-b border-border bg-[var(--surface-card,hsl(var(--card)))] px-3 py-1 text-xs',
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 text-xs text-[var(--text-muted,hsl(var(--muted-foreground)))]">
          {t('sessionGoal.label')}
        </span>
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            sessionGoalStatusDotClass(parsed.status)
          )}
          aria-hidden="true"
        />
        <span className="shrink-0 font-medium text-foreground/90">
          {statusText}
        </span>
        {onSelectGoal ? (
          <button
            type="button"
            onClick={onSelectGoal}
            title={parsed.objective}
            className="min-w-0 flex-1 truncate text-left text-xs text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {parsed.objective}
          </button>
        ) : (
          <span
            title={parsed.objective}
            className="min-w-0 flex-1 truncate text-xs text-foreground"
          >
            {parsed.objective}
          </span>
        )}
        {metaParts.length > 0 ? (
          <span className="shrink-0 tabular-nums text-xs text-[var(--text-muted,hsl(var(--muted-foreground)))]">
            {metaParts.join(' · ')}
          </span>
        ) : null}
      </div>

      {parsed.canPause || parsed.canClear ? (
        <div className="flex shrink-0 items-center gap-1">
          {parsed.canPause ? (
            <button
              type="button"
              data-testid="session-goal-pause"
              aria-label={t('sessionGoal.pauseAria')}
              title={t('sessionGoal.pause')}
              disabled={pendingAction !== null}
              onClick={() => {
                void handleAction('pause');
              }}
              className="composer-icon-control inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              {pendingAction === 'pause' ? (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Pause className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          ) : null}
          {parsed.canClear ? (
            <button
              type="button"
              data-testid="session-goal-clear"
              aria-label={t('sessionGoal.clearAria')}
              title={t('sessionGoal.clear')}
              disabled={pendingAction !== null}
              onClick={() => {
                void handleAction('clear');
              }}
              className="composer-icon-control inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              {pendingAction === 'clear' ? (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
