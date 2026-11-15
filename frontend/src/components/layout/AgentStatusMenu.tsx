import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { useTranslation } from 'react-i18next';
import type {
  AgentLifecycleState,
  AgentManagementView,
  AgentPlanUsage,
} from 'shared/types';

import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
import {
  buildPlanQuotaRows,
  clampPercent,
  describeReset,
  describeWindowLabel,
} from '@/components/kanban/planUsageFormat';
import type { AgentOperationState } from '@/features/agent-management';
import { isEnabledInstalledAgent } from '@/features/agents/operationalAgent';
import { AstryxStepper, AstryxStepperItem } from '@/features/basic-guide';
import { BASIC_GUIDE_OPEN_AGENT_STATUS_EVENT } from '@/features/basic-guide/basicGuideState';
import { presentAgentStatusRow } from '@/features/basic-guide/agentStatusPresentation';
import { cn } from '@/lib/utils';

type AgentStatusMenuProps = {
  agents: AgentManagementView[];
  defaultAgentId: string | null;
  updatableAgentIds?: ReadonlySet<string>;
  operations?: Record<string, AgentOperationState>;
  planUsages?: Partial<Record<string, AgentPlanUsage>>;
  onMenuOpen?: () => void;
  onOpenAgentSettings?: (agentId: string) => void;
};

function statusDotClass(lifecycle: AgentLifecycleState): string {
  switch (lifecycle) {
    case 'ready':
      return 'bg-[hsl(var(--success))]';
    case 'needs_auth':
    case 'needs_config':
      return 'bg-warning';
    case 'needs_repair':
    case 'platform_unsupported':
    case 'retired':
      return 'bg-destructive';
    case 'queued':
    case 'installing':
    case 'updating':
    case 'repairing':
    case 'uninstalled':
      return 'bg-primary';
  }
}

export function AgentStatusMenu({
  agents,
  defaultAgentId,
  updatableAgentIds,
  operations,
  planUsages,
  onMenuOpen,
  onOpenAgentSettings,
}: AgentStatusMenuProps) {
  const { t } = useTranslation(['statusbar', 'settings', 'tasks']);
  const [open, setOpen] = useState(false);
  const [forcedOpen, setForcedOpen] = useState(false);
  const onMenuOpenRef = useRef(onMenuOpen);
  onMenuOpenRef.current = onMenuOpen;

  const menuOpen = open || forcedOpen;
  const openMenu = () => {
    if (!menuOpen) {
      onMenuOpenRef.current?.();
    }
    setOpen(true);
  };

  useEffect(() => {
    const onForceOpen = () => {
      onMenuOpenRef.current?.();
      setForcedOpen(true);
      setOpen(true);
    };
    window.addEventListener(BASIC_GUIDE_OPEN_AGENT_STATUS_EVENT, onForceOpen);
    return () =>
      window.removeEventListener(
        BASIC_GUIDE_OPEN_AGENT_STATUS_EVENT,
        onForceOpen
      );
  }, []);

  const closeMenu = () => {
    setOpen(false);
    setForcedOpen(false);
  };
  const menuId = useId();
  const enabledAgents = useMemo(
    () => agents.filter(isEnabledInstalledAgent),
    [agents]
  );
  const defaultAgent =
    enabledAgents.find((agent) => agent.agent_id === defaultAgentId) ??
    enabledAgents[0];
  const hasUpdates = Boolean(
    updatableAgentIds &&
      enabledAgents.some((agent) => updatableAgentIds.has(agent.agent_id))
  );

  if (!defaultAgent) return null;

  const statusLabel = (agent: AgentManagementView) =>
    t(`agents.lifecycleStatus.${agent.lifecycle}`, { ns: 'settings' });
  const defaultStatus = statusLabel(defaultAgent);
  const triggerAria = hasUpdates
    ? t('agentStatus.defaultAgentAriaWithUpdate', {
        ns: 'statusbar',
        agent: defaultAgent.display_name,
        status: defaultStatus,
      })
    : t('agentStatus.defaultAgentAria', {
        ns: 'statusbar',
        agent: defaultAgent.display_name,
        status: defaultStatus,
      });

  return (
    <div
      className="relative flex h-5 items-center"
      data-basic-guide="agent-status-menu"
      onMouseEnter={openMenu}
      onMouseLeave={() => {
        if (!forcedOpen) setOpen(false);
      }}
      onFocusCapture={openMenu}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) closeMenu();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          closeMenu();
          event.currentTarget.querySelector('button')?.focus();
        }
      }}
    >
      <button
        type="button"
        aria-controls={menuId}
        aria-expanded={menuOpen}
        aria-label={triggerAria}
        className="flex h-5 items-center gap-1 rounded-full border border-border/60 bg-background/50 px-1.5 text-foreground/85 outline-none transition-colors hover:border-border hover:bg-accent/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={openMenu}
      >
        <span
          aria-hidden="true"
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            statusDotClass(defaultAgent.lifecycle)
          )}
        />
        <AgentManagementIcon
          agent={defaultAgent}
          className="h-3.5 w-3.5 shrink-0"
        />
        {hasUpdates ? (
          <span className="text-[10px] font-medium text-primary">
            {t('agentStatus.hasUpdates', { ns: 'statusbar' })}
          </span>
        ) : null}
      </button>

      {menuOpen && (
        <div className="absolute bottom-full right-0 z-50 pb-1.5">
          <div className="product-context-menu w-max max-h-[min(28rem,calc(100vh-3rem))] min-w-72 max-w-[min(42rem,calc(100vw-1.5rem))] overflow-y-auto rounded-md border border-border bg-popover p-1 font-sans text-[13px] leading-5 text-popover-foreground shadow-none animate-in fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none">
            <div
              id={menuId}
              role="list"
              aria-label={t('agentStatus.enabledAgentsAria', {
                ns: 'statusbar',
              })}
              className="grid grid-cols-[auto_auto_auto_auto_minmax(0,1fr)_auto] items-center"
            >
              {enabledAgents.map((agent) => {
                const isDefault = agent.agent_id === defaultAgent.agent_id;
                const canUpdate = Boolean(
                  updatableAgentIds?.has(agent.agent_id)
                );
                const row = presentAgentStatusRow(
                  agent,
                  operations?.[agent.agent_id]
                );
                const quotaRows = buildPlanQuotaRows(
                  planUsages?.[agent.agent_id]
                );
                const openSettings = () => {
                  onOpenAgentSettings?.(agent.agent_id);
                  closeMenu();
                };
                return (
                  <div
                    key={agent.agent_id}
                    role="listitem"
                    aria-label={agent.display_name}
                    className={cn(
                      'col-span-full grid grid-cols-subgrid min-h-8 items-center gap-x-2 whitespace-nowrap rounded-md px-2 py-1 text-xs',
                      quotaRows.length > 0 && 'gap-y-1 pb-1.5'
                    )}
                  >
                    <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                      <AgentManagementIcon agent={agent} className="h-4 w-4" />
                      <span
                        aria-hidden="true"
                        className={cn(
                          'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-popover',
                          statusDotClass(agent.lifecycle)
                        )}
                      />
                    </span>
                    <span className="font-medium text-foreground">
                      {agent.display_name}
                    </span>
                    {row.showStepper ? (
                      <AstryxStepper
                        current={row.stepperIndex}
                        onStepClick={() => openSettings()}
                      >
                        <AstryxStepperItem>
                          {t('agentStatus.acpDownload', { ns: 'statusbar' })}
                        </AstryxStepperItem>
                        <AstryxStepperItem>
                          {t('agentStatus.acpInstall', { ns: 'statusbar' })}
                        </AstryxStepperItem>
                        <AstryxStepperItem>
                          {t('agentStatus.acpCheck', { ns: 'statusbar' })}
                        </AstryxStepperItem>
                      </AstryxStepper>
                    ) : row.connectorAvailable ? (
                      <button
                        type="button"
                        className="justify-self-start rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-4 text-foreground outline-none hover:bg-accent/70 focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={openSettings}
                      >
                        {t('agentStatus.connectorReady', { ns: 'statusbar' })}
                      </button>
                    ) : (
                      <span />
                    )}
                    <button
                      type="button"
                      className="justify-self-start rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-4 text-muted-foreground outline-none hover:bg-accent/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={openSettings}
                    >
                      {row.loggedIn
                        ? t('agentStatus.loggedIn', { ns: 'statusbar' })
                        : t('agentStatus.loggedOut', { ns: 'statusbar' })}
                    </button>
                    {isDefault ? (
                      <span className="justify-self-end rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium leading-4 text-primary">
                        {t('agentStatus.defaultBadge', { ns: 'statusbar' })}
                      </span>
                    ) : (
                      <span />
                    )}
                    {canUpdate ? (
                      onOpenAgentSettings ? (
                        <button
                          type="button"
                          className="justify-self-end rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-4 text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-1 focus-visible:ring-ring"
                          onClick={openSettings}
                        >
                          {t('agentStatus.updateAvailable', {
                            ns: 'statusbar',
                          })}
                        </button>
                      ) : (
                        <span className="justify-self-end text-[10px] font-medium leading-4 text-primary">
                          {t('agentStatus.updateAvailable', {
                            ns: 'statusbar',
                          })}
                        </span>
                      )
                    ) : (
                      <span />
                    )}
                    {quotaRows.map((quotaRow, rowIndex) => (
                      <div
                        key={`quota-row-${rowIndex}`}
                        data-testid={`agent-status-quota-row-${agent.agent_id}-${rowIndex}`}
                        className="col-span-5 col-start-2 grid min-w-0 grid-cols-2 items-center gap-x-4 leading-4"
                      >
                        {quotaRow.map((item) => {
                          if (item.kind === 'credits') {
                            const creditsText = item.credits.unlimited
                              ? t('usageDashboard.planUsage.creditsUnlimited', {
                                  ns: 'tasks',
                                })
                              : t('usageDashboard.planUsage.creditsBalance', {
                                  ns: 'tasks',
                                  balance: item.credits.balance ?? '--',
                                });
                            return (
                              <div
                                key={item.id}
                                title={creditsText}
                                data-testid={`agent-status-quota-item-${agent.agent_id}-${item.id}`}
                                className="flex min-w-0 items-center text-muted-foreground"
                              >
                                <span className="truncate tabular-nums">
                                  {creditsText}
                                </span>
                              </div>
                            );
                          }

                          const { window: quotaWindow } = item;
                          const usedPercent = clampPercent(
                            quotaWindow.usedPercent
                          );
                          const remainingPercent =
                            usedPercent === null
                              ? null
                              : Math.max(0, 100 - usedPercent);
                          const labelDesc = describeWindowLabel(quotaWindow);
                          const windowLabel = t(
                            `usageDashboard.planUsage.${labelDesc.key}`,
                            labelDesc.count === undefined
                              ? { ns: 'tasks' }
                              : { ns: 'tasks', count: labelDesc.count }
                          );
                          const reset = describeReset(
                            quotaWindow.resetsAtMs,
                            Date.now()
                          );
                          const resetLabel =
                            reset === null
                              ? null
                              : reset.kind === 'soon'
                                ? t('usageDashboard.planUsage.resetsSoon', {
                                    ns: 'tasks',
                                  })
                                : t(
                                    `usageDashboard.planUsage.${
                                      reset.kind === 'minutes'
                                        ? 'resetsInMinutes'
                                        : reset.kind === 'hours'
                                          ? 'resetsInHours'
                                          : 'resetsInDays'
                                    }`,
                                    { ns: 'tasks', count: reset.count }
                                  );
                          const tooltipText = [
                            windowLabel,
                            usedPercent !== null
                              ? t('usageDashboard.planUsage.used', {
                                  ns: 'tasks',
                                  percent: usedPercent,
                                })
                              : null,
                            remainingPercent !== null
                              ? t('usageDashboard.planUsage.remaining', {
                                  ns: 'tasks',
                                  percent: remainingPercent,
                                })
                              : null,
                            resetLabel,
                          ]
                            .filter(Boolean)
                            .join(' · ');

                          return (
                            <div
                              key={item.id}
                              title={tooltipText}
                              data-testid={`agent-status-quota-item-${agent.agent_id}-${item.id}`}
                              className="flex min-w-0 items-center justify-between gap-2"
                            >
                              <span className="min-w-0 truncate text-muted-foreground">
                                {windowLabel}
                              </span>
                              <span className="flex shrink-0 items-center gap-1.5">
                                <span className="w-14 shrink-0">
                                  <ProgressBar
                                    value={usedPercent ?? 0}
                                    max={100}
                                    label={`${agent.display_name} ${windowLabel}`}
                                    isLabelHidden
                                    hasValueLabel={false}
                                    variant={
                                      usedPercent !== null && usedPercent >= 90
                                        ? 'error'
                                        : usedPercent !== null &&
                                            usedPercent >= 70
                                          ? 'warning'
                                          : 'accent'
                                    }
                                  />
                                </span>
                                <span className="w-8 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
                                  {usedPercent === null
                                    ? '--'
                                    : `${usedPercent}%`}
                                </span>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
