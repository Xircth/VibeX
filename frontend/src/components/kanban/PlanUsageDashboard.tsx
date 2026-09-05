import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CreditCard, RefreshCw } from 'lucide-react';
import type {
  AgentId,
  AgentAuthModeView,
  AgentManagementView,
  AgentPlanUsage,
  PlanUsageWindow,
} from 'shared/types';
import { PlanUsageUnavailableReason } from 'shared/types';
import { SurfaceLoading } from '@/components/layout/SurfaceLoading';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage,
  useAgentManagement,
} from '@/features/agent-management';
import { cn } from '@/lib/utils';
import {
  clampPercent,
  describeReset,
  describeWindowLabel,
  formatPlanType,
} from './planUsageFormat';

// The Claude usage endpoint is rate limited; keep probes to one per 3 minutes.
const PLAN_USAGE_STALE_TIME_MS = 180_000;

const PLAN_CAPABLE_AGENT_IDS = [
  'claude_code',
  'codex',
  'grok',
  'cursor',
] as const;

type PlanCapableAgentId = (typeof PLAN_CAPABLE_AGENT_IDS)[number];

const SUBSCRIPTION_MODES: Record<PlanCapableAgentId, string> = {
  claude_code: 'official_subscription',
  codex: 'chatgpt_subscription',
  grok: 'subscription',
  cursor: 'subscription',
};

const UNAVAILABLE_REASON_KEYS: Record<PlanUsageUnavailableReason, string> = {
  [PlanUsageUnavailableReason.UNSUPPORTED_AGENT]: 'reasonUnsupported',
  [PlanUsageUnavailableReason.CLI_NOT_FOUND]: 'reasonCliNotFound',
  [PlanUsageUnavailableReason.NOT_LOGGED_IN]: 'reasonNotLoggedIn',
  [PlanUsageUnavailableReason.TOKEN_EXPIRED]: 'reasonTokenExpired',
};

const PLAN_COPY: Record<PlanCapableAgentId, { title: string; source: string }> =
  {
    claude_code: { title: 'claudeTitle', source: 'claudeSource' },
    codex: { title: 'codexTitle', source: 'codexSource' },
    grok: { title: 'grokTitle', source: 'grokSource' },
    cursor: { title: 'cursorTitle', source: 'cursorSource' },
  };

function isPlanCapableAgentId(agentId: string): agentId is PlanCapableAgentId {
  return (PLAN_CAPABLE_AGENT_IDS as readonly string[]).includes(agentId);
}

function isSignedInSubscription(
  agent: AgentManagementView,
  authMode: AgentAuthModeView | undefined
) {
  return (
    agent.enabled &&
    agent.authentication === 'account' &&
    isPlanCapableAgentId(agent.agent_id) &&
    authMode?.mode === SUBSCRIPTION_MODES[agent.agent_id]
  );
}

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
  agentId,
  title,
  sourceNote,
}: {
  agentId: AgentId;
  title: string;
  sourceNote: string;
}) {
  const { t } = useTranslation('settings');
  const pt = usePlanKey();
  const [managing, setManaging] = useState(false);
  const query = useQuery({
    queryKey: ['agent-plan-usage', agentId],
    queryFn: () => agentManagementApi.planUsage(agentId),
    staleTime: PLAN_USAGE_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });

  const result = query.data ?? null;
  const planType =
    result?.type === 'OK' ? formatPlanType(result.usage.planType) : null;

  const manageSubscription = async () => {
    setManaging(true);
    try {
      await agentManagementApi.runAction(agentId, 'subscription');
    } catch (error) {
      toast.error(
        agentManagementErrorMessage(error, t('agents.accountFlowFailed'))
      );
    } finally {
      setManaging(false);
    }
  };

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
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void manageSubscription()}
            disabled={managing}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {pt('manageSubscription')}
          </button>
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', query.isFetching && 'animate-spin')}
            />
            {pt('refresh')}
          </button>
        </div>
      </div>

      {query.isLoading ? (
        <SurfaceLoading label={pt('loading')} sections={1} />
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
  const management = useAgentManagement();
  const candidatePlanAgents = useMemo(
    () =>
      management.state.agents.filter(
        (agent) =>
          agent.enabled &&
          agent.authentication === 'account' &&
          isPlanCapableAgentId(agent.agent_id)
      ),
    [management.state.agents]
  );
  const authQueries = useQueries({
    queries: candidatePlanAgents.map((agent) => ({
      queryKey: ['agent-auth-mode', agent.agent_id],
      queryFn: () => agentManagementApi.authMode(agent.agent_id),
      staleTime: PLAN_USAGE_STALE_TIME_MS,
      refetchOnWindowFocus: false,
    })),
  });
  const subscribedPlanAgents = useMemo(
    () =>
      candidatePlanAgents.filter((agent, index) =>
        isSignedInSubscription(agent, authQueries[index]?.data)
      ),
    [authQueries, candidatePlanAgents]
  );
  const authLoading = authQueries.some(
    (query) => query.isLoading || query.isPending
  );

  return (
    <div className="plan-usage-page mx-auto flex w-full max-w-4xl flex-col gap-4">
      {management.loading || authLoading ? (
        <SurfaceLoading label={pt('loading')} />
      ) : subscribedPlanAgents.length === 0 ? (
        <div className="rounded-lg border border-border bg-background p-4 text-sm text-muted-foreground">
          {pt('emptySignedIn')}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {subscribedPlanAgents.map((agent) => {
            const copy = PLAN_COPY[agent.agent_id as PlanCapableAgentId];
            return (
              <div
                key={agent.agent_id}
                className="rounded-xl border border-border bg-card p-4"
              >
                <AgentPlanSection
                  agentId={agent.agent_id}
                  title={pt(copy.title)}
                  sourceNote={pt(copy.source)}
                />
              </div>
            );
          })}
        </div>
      )}
      {!authLoading && subscribedPlanAgents.length > 0 ? (
        <p className="text-xs text-muted-foreground">{pt('hint')}</p>
      ) : null}
    </div>
  );
}
