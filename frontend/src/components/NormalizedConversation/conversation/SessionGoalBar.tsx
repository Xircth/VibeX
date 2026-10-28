import { useCallback, useState } from 'react';
import { Flag, Loader2, Pause, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationSessionGoal, GoalControlReceipt } from 'shared/types';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { getErrorMessage } from '@/lib/modals';
import type { CodexGoalState } from '@/lib/codexGoalState';
import {
  formatGoalDuration,
  formatGoalTokens,
  isLimitedGoalStatus,
  parseConversationSessionGoal,
  parseSessionGoalValue,
  type SessionGoalStatus,
} from '@/lib/sessionGoal';

export function sessionGoalStatusDotClass(status: SessionGoalStatus): string {
  switch (status) {
    case 'active':
      return 'bg-[hsl(var(--success))]';
    case 'paused':
      return 'bg-[hsl(var(--warning))]';
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
  fallbackGoal?: CodexGoalState | null;
  sessionBindReady?: boolean;
  onGoalControl?: (action: 'pause' | 'clear') => Promise<GoalControlReceipt>;
  onSelectGoal?: () => void;
  className?: string;
}

export function SessionGoalBar({
  sessionGoal,
  fallbackGoal = null,
  sessionBindReady = true,
  onGoalControl,
  onSelectGoal,
  className,
}: SessionGoalBarProps) {
  const { t } = useTranslation('conversation');
  const [pendingAction, setPendingAction] = useState<'pause' | 'clear' | null>(
    null
  );

  const canControl = sessionBindReady && Boolean(onGoalControl);
  const parsed =
    parseConversationSessionGoal(sessionGoal, {
      sessionBindReady: canControl,
    }) ??
    (fallbackGoal &&
    (fallbackGoal.status === 'running' || fallbackGoal.status === 'paused')
      ? parseSessionGoalValue(
          {
            objective: fallbackGoal.objective,
            status: fallbackGoal.status === 'paused' ? 'paused' : 'active',
          },
          {
            actions: sessionGoal?.actions ?? null,
            sessionBindReady: canControl,
          }
        )
      : null);

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

  const objectiveTrigger = onSelectGoal ? (
    <button
      type="button"
      onClick={onSelectGoal}
      title={parsed.objective}
      className="min-w-0 flex-1 truncate text-left text-xs font-medium text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {parsed.objective}
    </button>
  ) : (
    <span
      title={parsed.objective}
      className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
    >
      {parsed.objective}
    </span>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div
        role="status"
        data-testid="session-goal-bar"
        data-goal-status={parsed.status}
        className={cn(
          'flex min-h-9 shrink-0 items-center justify-between gap-2.5 overflow-hidden rounded-lg border border-border bg-[var(--surface-card,hsl(var(--card)))] px-2.5 py-1.5 text-xs',
          className
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted/70 px-2 py-0.5 text-xs font-medium text-foreground/90">
            <Flag
              className="h-3 w-3 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span>{t('sessionGoal.label')}</span>
            <span
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                sessionGoalStatusDotClass(parsed.status)
              )}
              aria-hidden="true"
            />
            <span className="text-muted-foreground">{statusText}</span>
          </span>

          <Tooltip>
            <TooltipTrigger asChild>{objectiveTrigger}</TooltipTrigger>
            <TooltipContent side="top" className="max-w-96">
              <div className="space-y-1 text-xs">
                <div className="flex items-center gap-1.5 font-medium">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      sessionGoalStatusDotClass(parsed.status)
                    )}
                    aria-hidden="true"
                  />
                  <span>
                    {t('sessionGoal.label')} · {statusText}
                  </span>
                </div>
                <div className="break-words text-muted-foreground">
                  {parsed.objective}
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        </div>

        {metaParts.length > 0 || parsed.canPause || parsed.canClear ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {metaParts.length > 0 ? (
              <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                {metaParts.join(' · ')}
              </span>
            ) : null}

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
                className="inline-flex h-6 items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                {pendingAction === 'pause' ? (
                  <Loader2
                    className="h-3 w-3 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Pause className="h-3 w-3" aria-hidden="true" />
                )}
                <span>{t('sessionGoal.pause')}</span>
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
                className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                {pendingAction === 'clear' ? (
                  <Loader2
                    className="h-3 w-3 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <X className="h-3 w-3" aria-hidden="true" />
                )}
                <span>{t('sessionGoal.clear')}</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
