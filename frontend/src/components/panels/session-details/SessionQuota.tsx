import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import type { AgentId, PlanUsageWindow } from 'shared/types';
import { PlanUsageUnavailableReason } from 'shared/types';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage,
  useAgentManagement,
} from '@/features/agent-management';
import {
  isPlanCapableAgentId,
  isSignedInSubscription,
} from '@/components/kanban/agentSubscriptionAuth';
import {
  clampPercent,
  describeReset,
  describeWindowLabel,
  formatPlanType,
} from '@/components/kanban/planUsageFormat';

const PLAN_USAGE_STALE_TIME_MS = 180_000;

const UNAVAILABLE_REASON_KEYS: Record<PlanUsageUnavailableReason, string> = {
  [PlanUsageUnavailableReason.UNSUPPORTED_AGENT]: 'reasonUnsupported',
  [PlanUsageUnavailableReason.CLI_NOT_FOUND]: 'reasonCliNotFound',
  [PlanUsageUnavailableReason.NOT_LOGGED_IN]: 'reasonNotLoggedIn',
  [PlanUsageUnavailableReason.TOKEN_EXPIRED]: 'reasonTokenExpired',
};

function QuotaWindow({ window }: { window: PlanUsageWindow }) {
  const { t } = useTranslation('tasks');
  const usedPercent = clampPercent(window.usedPercent);
  const label = describeWindowLabel(window);
  const reset = describeReset(window.resetsAtMs, Date.now());
  const resetLabel =
    reset === null
      ? null
      : reset.kind === 'soon'
        ? t('usageDashboard.planUsage.resetsSoon')
        : t(
            reset.kind === 'minutes'
              ? 'usageDashboard.planUsage.resetsInMinutes'
              : reset.kind === 'hours'
                ? 'usageDashboard.planUsage.resetsInHours'
                : 'usageDashboard.planUsage.resetsInDays',
            { count: reset.count }
          );

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-foreground">
          {t(
            `usageDashboard.planUsage.${label.key}`,
            label.count === undefined ? undefined : { count: label.count }
          )}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {usedPercent === null
            ? t('panels:sessionDetails.missing')
            : t('usageDashboard.planUsage.used', { percent: usedPercent })}
        </span>
      </div>
      <ProgressBar
        value={usedPercent ?? 0}
        max={100}
        label={t(`usageDashboard.planUsage.${label.key}`, {
          count: label.count,
        })}
        isLabelHidden
        hasValueLabel={false}
        variant={
          usedPercent !== null && usedPercent >= 90
            ? 'error'
            : usedPercent !== null && usedPercent >= 70
              ? 'warning'
              : 'accent'
        }
      />
      {resetLabel ? (
        <p className="text-xs text-muted-foreground">{resetLabel}</p>
      ) : null}
    </div>
  );
}

function PlanTypeChip({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
      {name}
    </span>
  );
}

export function SessionQuota({
  agentId,
  onActive,
}: {
  agentId: string | null;
  onActive?: (active: boolean) => void;
}) {
  const { t } = useTranslation(['panels', 'tasks', 'settings']);
  const management = useAgentManagement();
  const agent = management.state.agents.find(
    (item) => item.agent_id === agentId
  );
  const canAsk =
    !!agent &&
    agent.enabled &&
    agent.authentication === 'account' &&
    isPlanCapableAgentId(agent.agent_id);
  const authQuery = useQuery({
    queryKey: ['agent-auth-mode', agent?.agent_id],
    queryFn: () => agentManagementApi.authMode(agent!.agent_id),
    enabled: canAsk,
    staleTime: PLAN_USAGE_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
  const subscribed = !!agent && isSignedInSubscription(agent, authQuery.data);
  const usageQuery = useQuery({
    queryKey: ['agent-plan-usage', agent?.agent_id],
    queryFn: () => agentManagementApi.planUsage(agent!.agent_id as AgentId),
    enabled: subscribed,
    staleTime: PLAN_USAGE_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
  const [managing, setManaging] = useState(false);
  const active = canAsk && !authQuery.isLoading && subscribed;

  useEffect(() => {
    onActive?.(active);
  }, [active, onActive]);

  useEffect(() => () => onActive?.(false), [onActive]);

  if (!agent || !active) return null;

  const result = usageQuery.data ?? null;
  const planType =
    result?.type === 'OK' ? formatPlanType(result.usage.planType) : null;

  const manageSubscription = async () => {
    if (!agent) return;
    setManaging(true);
    try {
      await agentManagementApi.runAction(agent.agent_id, 'subscription');
    } catch (error) {
      toast.error(
        agentManagementErrorMessage(
          error,
          t('settings:agents.accountFlowFailed')
        )
      );
    } finally {
      setManaging(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="session-quota">
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-sm text-foreground">
          <AgentIcon
            agent={agent.agent_id}
            className="h-4 w-4"
            iconLight={agent.icon_light}
            iconDark={agent.icon_dark}
            iconSvg={agent.icon_svg}
          />
          <span className="truncate font-medium">
            {agent.display_name.trim() || getAgentName(agent.agent_id)}
          </span>
          {planType ? <PlanTypeChip name={planType} /> : null}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          isLoading={managing}
          onClick={() => void manageSubscription()}
        >
          {t('panels:sessionDetails.manageSubscription')}
        </Button>
      </div>
      {usageQuery.isLoading ? (
        <Loader size={16} />
      ) : result?.type === 'OK' ? (
        result.usage.windows.length > 0 ? (
          <div className="flex flex-col gap-2">
            {result.usage.windows.map((window) => (
              <QuotaWindow key={window.id} window={window} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('tasks:usageDashboard.planUsage.noWindows')}
          </p>
        )
      ) : result?.type === 'UNAVAILABLE' ? (
        <p className="text-xs text-muted-foreground">
          {t(
            `tasks:usageDashboard.planUsage.${UNAVAILABLE_REASON_KEYS[result.reason]}`
          )}
        </p>
      ) : result?.type === 'ERROR' ? (
        <p className="text-xs text-destructive">{result.message}</p>
      ) : null}
      {result?.type === 'OK' && result.usage.credits ? (
        <p className="text-xs text-muted-foreground">
          {result.usage.credits.unlimited
            ? t('tasks:usageDashboard.planUsage.creditsUnlimited')
            : t('tasks:usageDashboard.planUsage.creditsBalance', {
                balance:
                  result.usage.credits.balance ??
                  t('panels:sessionDetails.missing'),
              })}
        </p>
      ) : null}
    </div>
  );
}
