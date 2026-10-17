import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentLifecycleState, AgentManagementView } from 'shared/types';

import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
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
  preflightPassedIds?: ReadonlySet<string>;
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
  preflightPassedIds,
  onOpenAgentSettings,
}: AgentStatusMenuProps) {
  const { t } = useTranslation(['statusbar', 'settings']);
  const [open, setOpen] = useState(false);
  const [forcedOpen, setForcedOpen] = useState(false);

  useEffect(() => {
    const onForceOpen = () => {
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

  const menuOpen = open || forcedOpen;
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
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!forcedOpen) setOpen(false);
      }}
      onFocusCapture={() => setOpen(true)}
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
        onClick={() => setOpen(true)}
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
          <div className="product-context-menu max-h-[min(24rem,calc(100vh-3rem))] min-w-72 overflow-y-auto rounded-md border border-border bg-white p-1 font-sans text-[13px] leading-5 text-popover-foreground shadow-none dark:bg-popover animate-in fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none">
            <div
              id={menuId}
              role="list"
              aria-label={t('agentStatus.enabledAgentsAria', {
                ns: 'statusbar',
              })}
              className="flex flex-col"
            >
              {enabledAgents.map((agent) => {
                const isDefault = agent.agent_id === defaultAgent.agent_id;
                const canUpdate = Boolean(
                  updatableAgentIds?.has(agent.agent_id)
                );
                const row = presentAgentStatusRow(
                  agent,
                  operations?.[agent.agent_id],
                  null
                );
                const agentAvailable = Boolean(
                  preflightPassedIds?.has(agent.agent_id)
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
                    className="flex min-h-8 flex-col gap-1 rounded-md px-2 py-1 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                        <AgentManagementIcon
                          agent={agent}
                          className="h-4 w-4"
                        />
                        <span
                          aria-hidden="true"
                          className={cn(
                            'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-popover',
                            statusDotClass(agent.lifecycle)
                          )}
                        />
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                        {agent.display_name}
                      </span>
                      {isDefault && (
                        <span className="rounded bg-primary/10 px-1 py-0.5 text-[9px] font-medium text-primary">
                          {t('agentStatus.defaultBadge', { ns: 'statusbar' })}
                        </span>
                      )}
                      {canUpdate ? (
                        onOpenAgentSettings ? (
                          <button
                            type="button"
                            className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-1 focus-visible:ring-ring"
                            onClick={openSettings}
                          >
                            {t('agentStatus.updateAvailable', {
                              ns: 'statusbar',
                            })}
                          </button>
                        ) : (
                          <span className="shrink-0 text-[10px] font-medium text-primary">
                            {t('agentStatus.updateAvailable', {
                              ns: 'statusbar',
                            })}
                          </span>
                        )
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pl-7">
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
                          className="rounded-full px-1.5 py-0.5 text-[10px] font-medium text-foreground outline-none hover:bg-accent/70 focus-visible:ring-1 focus-visible:ring-ring"
                          onClick={openSettings}
                        >
                          {t('agentStatus.connectorReady', { ns: 'statusbar' })}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="rounded-full px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground outline-none hover:bg-accent/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={openSettings}
                      >
                        {row.loggedIn
                          ? t('agentStatus.loggedIn', { ns: 'statusbar' })
                          : t('agentStatus.loggedOut', { ns: 'statusbar' })}
                      </button>
                      {row.connectorAvailable &&
                      row.loggedIn &&
                      agentAvailable ? (
                        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          {t('agentStatus.agentReady', { ns: 'statusbar' })}
                        </span>
                      ) : null}
                    </div>
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
