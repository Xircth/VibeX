import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  AgentLifecycleState,
  ExecutorConfig,
  ExecutorProfileId,
} from 'shared/types';
import { AgentIcon } from '@/components/agents/AgentIcon';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { isEnabledInstalledAgent } from '@/features/agents/operationalAgent';
import type { SelectableAgent } from '@/features/agents/useSelectableAgents';
import { canonicalSessionAgentId } from '@/lib/sessionQueryCache';
import { getDefaultProfileForExecutor } from '@/utils/executor';

export function unavailableAgentStatusKey(
  lifecycle: AgentLifecycleState
): string {
  switch (lifecycle) {
    case 'needs_auth':
      return 'agentSelector.needsAuth';
    case 'needs_config':
      return 'agentSelector.needsConfig';
    case 'needs_repair':
      return 'agentSelector.needsRepair';
    case 'platform_unsupported':
      return 'agentSelector.platformUnsupported';
    case 'retired':
      return 'agentSelector.retired';
    case 'queued':
    case 'installing':
    case 'updating':
    case 'repairing':
      return 'agentSelector.inProgress';
    case 'uninstalled':
      return 'agentSelector.notInstalled';
    case 'ready':
      return 'agentSelector.unavailable';
  }
}

export interface AgentRailProps {
  profiles: Record<string, ExecutorConfig> | null;
  effectiveExecutorProfile: ExecutorProfileId | null;
  onChangeExecutorProfile: (profile: ExecutorProfileId) => void;
  disabled?: boolean;
  selectableAgents: SelectableAgent[];
}

export function AgentRail({
  profiles,
  effectiveExecutorProfile,
  onChangeExecutorProfile,
  disabled = false,
  selectableAgents,
}: AgentRailProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const activeButtonRef = useRef<HTMLButtonElement | null>(null);

  const agents = useMemo(
    () =>
      selectableAgents
        .filter(isEnabledInstalledAgent)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [selectableAgents]
  );

  const selectedAgent = effectiveExecutorProfile?.executor ?? null;
  const canonicalSelectedAgent = selectedAgent
    ? canonicalSessionAgentId(selectedAgent)
    : null;

  useEffect(() => {
    activeButtonRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedAgent]);

  if (!profiles || agents.length === 0) return null;

  return (
    <TooltipProvider delayDuration={180}>
      <div
        className="flex flex-col items-center gap-1"
        role="radiogroup"
        aria-label={t('agentRail.label')}
      >
        {agents.map((agent) => {
          const isActive =
            selectedAgent === agent.agentId ||
            (canonicalSelectedAgent !== null &&
              canonicalSelectedAgent ===
                canonicalSessionAgentId(agent.agentId));
          const clickable = agent.runnable && !disabled;
          const unavailableLabel = !agent.runnable
            ? t(unavailableAgentStatusKey(agent.lifecycle))
            : null;
          const tooltipLabel = unavailableLabel
            ? `${agent.displayName} · ${unavailableLabel}`
            : agent.displayName;

          return (
            <Tooltip key={agent.agentId}>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <button
                    ref={isActive ? activeButtonRef : undefined}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    aria-label={agent.displayName}
                    disabled={!clickable}
                    title={unavailableLabel ?? undefined}
                    onClick={() => {
                      if (!clickable) return;
                      const nextProfile = getDefaultProfileForExecutor(
                        agent.agentId,
                        profiles
                      ) ?? {
                        executor: agent.agentId,
                        variant: null,
                      };
                      onChangeExecutorProfile(nextProfile);
                    }}
                    className={cn(
                      'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-transparent transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                      isActive
                        ? 'text-foreground opacity-100'
                        : 'opacity-55 hover:opacity-100',
                      !clickable && 'cursor-not-allowed opacity-30'
                    )}
                  >
                    <AgentIcon
                      agent={agent.agentId}
                      className="h-4 w-4"
                      iconLight={agent.iconLight}
                      iconDark={agent.iconDark}
                      iconSvg={agent.iconSvg}
                    />
                    {isActive ? (
                      <span
                        aria-hidden="true"
                        data-testid="agent-rail-active-indicator"
                        className="pointer-events-none absolute -right-0.5 top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded-full bg-foreground"
                      />
                    ) : null}
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="left">{tooltipLabel}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
