import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ExecutorConfig, ExecutorProfileId } from 'shared/types';
import { AgentIcon } from '@/components/agents/AgentIcon';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  isEnabledInstalledAgent,
} from '@/features/agents/operationalAgent';
import type { SelectableAgent } from '@/features/agents/useSelectableAgents';
import type { AgentLifecycleState } from 'shared/types';

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

interface AgentRailProps {
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

  const agents = useMemo(
    () =>
      selectableAgents
        .filter(isEnabledInstalledAgent)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [selectableAgents]
  );

  if (!profiles || agents.length === 0) return null;

  const selectedAgent = effectiveExecutorProfile?.executor ?? null;

  return (
    <div
      className="flex flex-col items-center gap-0.5"
      role="radiogroup"
      aria-label={t('agentRail.label')}
    >
      {agents.map((agent) => {
        const isActive = selectedAgent === agent.agentId;
        const clickable = agent.runnable && !disabled;

        return (
          <Tooltip key={agent.agentId}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="radio"
                aria-checked={isActive}
                aria-label={agent.displayName}
                disabled={!clickable}
                title={
                  !clickable
                    ? t(unavailableAgentStatusKey(agent.lifecycle))
                    : undefined
                }
                onClick={() => {
                  if (!clickable) return;
                  onChangeExecutorProfile({
                    executor: agent.agentId,
                    variant: null,
                  });
                }}
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-all',
                  isActive
                    ? 'raised-control ring-1 ring-primary/40'
                    : 'bg-transparent hover:bg-muted/50 opacity-60 hover:opacity-100',
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
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {agent.displayName}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
