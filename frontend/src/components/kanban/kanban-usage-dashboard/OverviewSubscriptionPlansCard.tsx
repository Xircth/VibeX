import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { useTranslation } from 'react-i18next';
import { Package } from 'lucide-react';
import type { AgentManagementView } from 'shared/types';
import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';

import {
  clampPercent,
  describeReset,
  describeWindowLabel,
  formatPlanType,
} from '../planUsageFormat';
import {
  PLAN_USAGE_STALE_TIME_MS,
  useActiveSubscriptionPlans,
} from '../useActiveSubscriptionPlans';

import { UsageCardHeader } from './UsageCards';

export { PLAN_USAGE_STALE_TIME_MS };

export function OverviewSubscriptionPlansCard({
  agents,
}: {
  agents: AgentManagementView[];
}) {
  const { t } = useTranslation('tasks');
  const { activeSubscriptionPlans } = useActiveSubscriptionPlans(agents);

  if (activeSubscriptionPlans.length === 0) {
    return null;
  }

  return (
    <section
      aria-label={t('usageDashboard.subscriptionPlansTitle')}
      data-testid="overview-subscription-plans-card"
      className="kanban-usage-card flex min-w-0 flex-col p-4"
    >
      <UsageCardHeader
        icon={Package}
        title={t('usageDashboard.subscriptionPlansTitle')}
      />
      <div className="flex flex-col gap-3">
        {activeSubscriptionPlans.map(({ agent, usage }) => {
          const agentLabel = agent.display_name || agent.agent_id;
          const planName = formatPlanType(usage.planType);
          const windows = usage.windows;
          const columnCount = Math.max(1, windows.length);

          return (
            <div
              key={agent.agent_id}
              data-testid={`subscription-plan-row-${agent.agent_id}`}
              className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="flex w-40 shrink-0 items-center gap-2 min-w-0">
                <AgentManagementIcon
                  agent={agent}
                  className="size-4 shrink-0"
                />
                <span className="min-w-0">
                  <span
                    title={agentLabel}
                    className="block truncate text-[13px] font-medium text-foreground"
                  >
                    {agentLabel}
                  </span>
                  {planName ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {planName}
                    </span>
                  ) : null}
                </span>
              </div>

              {windows.length > 0 ? (
                <div
                  data-testid={`subscription-plan-windows-${agent.agent_id}`}
                  className="grid min-w-0 flex-1 items-center gap-4"
                  style={{
                    gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                  }}
                >
                  {windows.map((window) => {
                    const usedPercent = clampPercent(window.usedPercent);
                    const remainingPercent =
                      usedPercent === null
                        ? null
                        : Math.max(0, 100 - usedPercent);
                    const labelDesc = describeWindowLabel(window);
                    const windowLabel = t(
                      `usageDashboard.planUsage.${labelDesc.key}`,
                      labelDesc.count === undefined
                        ? undefined
                        : { count: labelDesc.count }
                    );
                    const reset = describeReset(window.resetsAtMs, Date.now());
                    const resetLabel =
                      reset === null
                        ? null
                        : reset.kind === 'soon'
                          ? t('usageDashboard.planUsage.resetsSoon')
                          : t(
                              `usageDashboard.planUsage.${
                                reset.kind === 'minutes'
                                  ? 'resetsInMinutes'
                                  : reset.kind === 'hours'
                                    ? 'resetsInHours'
                                    : 'resetsInDays'
                              }`,
                              { count: reset.count }
                            );
                    const tooltipText = [
                      windowLabel,
                      usedPercent !== null
                        ? t('usageDashboard.planUsage.used', {
                            percent: usedPercent,
                          })
                        : null,
                      remainingPercent !== null
                        ? t('usageDashboard.planUsage.remaining', {
                            percent: remainingPercent,
                          })
                        : null,
                      resetLabel,
                    ]
                      .filter(Boolean)
                      .join(' · ');

                    return (
                      <div
                        key={window.id}
                        title={tooltipText}
                        className="flex min-w-0 items-center gap-2.5"
                      >
                        <span className="inline-flex h-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/90 px-2.5 text-xs font-medium leading-none text-foreground/85">
                          {windowLabel}
                        </span>
                        <ProgressBar
                          value={usedPercent ?? 0}
                          max={100}
                          label={`${agentLabel} ${windowLabel}`}
                          isLabelHidden
                          hasValueLabel={false}
                          variant={
                            usedPercent !== null && usedPercent >= 90
                              ? 'error'
                              : usedPercent !== null && usedPercent >= 70
                                ? 'warning'
                                : 'accent'
                          }
                          className="min-w-0 flex-1"
                        />
                        <span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {usedPercent === null ? '--' : `${usedPercent}%`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {usage.credits ? (
                <span className="inline-flex h-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/90 px-2.5 text-xs font-medium leading-none tabular-nums text-foreground/85">
                  {usage.credits.unlimited
                    ? t('usageDashboard.planUsage.creditsUnlimited')
                    : t('usageDashboard.planUsage.creditsBalance', {
                        balance: usage.credits.balance ?? '--',
                      })}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
