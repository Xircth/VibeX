import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CreditCard, RefreshCw } from 'lucide-react';
import type { AgentPlanUsage, PlanUsageWindow } from 'shared/types';
import { PlanUsageUnavailableReason } from 'shared/types';
import { agentsApi } from '@/features/agents/api';
import type { AgentType } from '@/features/agents/types';
import { cn } from '@/lib/utils';
import {
  clampPercent,
  describeReset,
  describeWindowLabel,
  formatPlanType,
} from './planUsageFormat';

// The Claude usage endpoint is rate limited; keep probes to one per 3 minutes.
const PLAN_USAGE_STALE_TIME_MS = 180_000;

const UNAVAILABLE_REASON_KEYS: Record<PlanUsageUnavailableReason, string> = {
  [PlanUsageUnavailableReason.UNSUPPORTED_AGENT]: 'reasonUnsupported',
  [PlanUsageUnavailableReason.CLI_NOT_FOUND]: 'reasonCliNotFound',
  [PlanUsageUnavailableReason.NOT_LOGGED_IN]: 'reasonNotLoggedIn',
  [PlanUsageUnavailableReason.TOKEN_EXPIRED]: 'reasonTokenExpired',
};

function usePlanKey() {
  const { t } = useTranslation('tasks');
  return (suffix: string, options?: Record<string, unknown>) =>
    t(`usageDashboard.planUsage.${suffix}`, options);
}

function WindowRow({ window }: { window: PlanUsageWindow }) {
  const pt = usePlanKey();
  const usedPercent = clampPercent(window.usedPercent);
  const remainingPercent =
    usedPercent === null ? null : Math.max(0, 100 - usedPercent);
  const label = describeWindowLabel(window);
  const reset = describeReset(window.resetsAtMs, Date.now());
  const resetLabel =
    reset === null
      ? null
      : reset.kind === 'soon'
        ? pt('resetsSoon')
        : pt(
            reset.kind === 'minutes'
              ? 'resetsInMinutes'
              : reset.kind === 'hours'
                ? 'resetsInHours'
                : 'resetsInDays',
            { count: reset.count }
          );

  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">
            {pt(
              label.key,
              label.count === undefined ? undefined : { count: label.count }
            )}
          </div>
          {resetLabel ? (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {resetLabel}
            </div>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold text-foreground">
            {usedPercent === null ? '--' : pt('used', { percent: usedPercent })}
          </div>
          <div className="text-xs text-muted-foreground">
            {remainingPercent === null
              ? '--'
              : pt('remaining', { percent: remainingPercent })}
          </div>
        </div>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            usedPercent !== null && usedPercent >= 90
              ? 'bg-destructive'
              : usedPercent !== null && usedPercent >= 70
                ? 'bg-warning'
                : 'bg-primary'
          )}
          style={{ width: `${usedPercent ?? 0}%` }}
        />
      </div>
    </div>
  );
}

function UsageBody({ usage }: { usage: AgentPlanUsage }) {
  const pt = usePlanKey();

  return (
    <div className="flex flex-col gap-3">
      {usage.windows.length === 0 ? (
        <div className="rounded-lg border border-border bg-background p-4 text-sm text-muted-foreground">
          {pt('noWindows')}
        </div>
      ) : (
        usage.windows.map((window) => (
          <WindowRow key={window.id} window={window} />
        ))
      )}

      {usage.credits ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background p-3 text-sm text-muted-foreground">
          <CreditCard className="h-4 w-4 shrink-0" />
          <span>
            {usage.credits.unlimited
              ? pt('creditsUnlimited')
              : pt('creditsBalance', {
                  balance: usage.credits.balance ?? '--',
                })}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function AgentPlanSection({
  agentType,
  title,
  sourceNote,
}: {
  agentType: AgentType;
  title: string;
  sourceNote: string;
}) {
  const pt = usePlanKey();
  const query = useQuery({
    queryKey: ['agent-plan-usage', agentType],
    queryFn: () => agentsApi.planUsage({ agentType }),
    staleTime: PLAN_USAGE_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });

  const result = query.data ?? null;
  const planType =
    result?.type === 'OK' ? formatPlanType(result.usage.planType) : null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            {planType ? (
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                {pt('planLabel', { plan: planType })}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{sourceNote}</p>
        </div>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw
            className={cn('h-3.5 w-3.5', query.isFetching && 'animate-spin')}
          />
          {pt('refresh')}
        </button>
      </div>

      {query.isLoading ? (
        <div className="rounded-lg border border-border bg-background p-4 text-sm text-muted-foreground">
          {pt('loading')}
        </div>
      ) : result?.type === 'OK' ? (
        <UsageBody usage={result.usage} />
      ) : result?.type === 'UNAVAILABLE' ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-background p-4 text-sm text-muted-foreground">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{pt(UNAVAILABLE_REASON_KEYS[result.reason])}</span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-background p-4 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <div className="font-medium text-foreground">
              {pt('errorTitle')}
            </div>
            <div className="mt-0.5 break-words text-muted-foreground">
              {result?.type === 'ERROR'
                ? result.message
                : query.error instanceof Error
                  ? query.error.message
                  : String(query.error ?? '')}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function PlanUsageDashboard() {
  const pt = usePlanKey();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <AgentPlanSection
        agentType="claude_code"
        title={pt('claudeTitle')}
        sourceNote={pt('claudeSource')}
      />
      <AgentPlanSection
        agentType="codex"
        title={pt('codexTitle')}
        sourceNote={pt('codexSource')}
      />
      <p className="text-xs text-muted-foreground">{pt('hint')}</p>
    </div>
  );
}
