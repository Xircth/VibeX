import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ArrowDown, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AgentLifecycleState, ExecutorProfileId } from 'shared/types';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { useSelectableAgents } from '@/features/agents/useSelectableAgents';
import { settingsWindowApi } from '@/lib/api';

interface AgentSelectorProps {
  profiles: Record<string, Record<string, unknown>> | null;
  selectedExecutorProfile: ExecutorProfileId | null;
  onChange: (profile: ExecutorProfileId) => void;
  disabled?: boolean;
  className?: string;
  iconOnly?: boolean;
  dropdownSide?: 'top' | 'bottom';
}

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

export function AgentSelector({
  profiles,
  selectedExecutorProfile,
  onChange,
  disabled,
  className = '',
  iconOnly = false,
  dropdownSide = 'bottom',
}: AgentSelectorProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const selectable = useSelectableAgents();
  const agents = useMemo(() => {
    return selectable
      .filter((agent) => agent.enabled)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [selectable]);
  const selectedAgent = selectedExecutorProfile?.executor;
  const selectedAgentLabel =
    agents.find((agent) => agent.agentId === selectedAgent)?.displayName ??
    selectedAgent ??
    'Agent';

  if (!profiles) return null;

  return (
    <div className={iconOnly ? 'shrink-0' : 'flex-1'}>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant={iconOnly ? 'ghost' : 'outline'}
            size="sm"
            className={`${iconOnly ? 'h-7 w-7 px-0 justify-center gap-0 border-0 shadow-none' : 'w-full justify-between'} text-xs ${className}`}
            disabled={disabled}
            aria-label={t('agentSelector.selectAgentAriaLabel')}
            title={selectedAgentLabel}
          >
            <div
              className={
                iconOnly
                  ? 'flex items-center justify-center'
                  : 'flex items-center gap-1.5 w-full'
              }
            >
              {selectedAgent ? (
                <AgentIcon agent={selectedAgent} className="h-3.5 w-3.5" />
              ) : (
                <Bot className="h-3.5 w-3.5" />
              )}
              {!iconOnly ? (
                <span className="truncate">{selectedAgentLabel}</span>
              ) : null}
            </div>
            {!iconOnly ? <ArrowDown className="h-3 w-3 shrink-0" /> : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={dropdownSide}
          align="start"
          sideOffset={1}
          avoidCollisions={false}
          className="w-60"
        >
          {agents.length === 0 ? (
            <div className="p-2 text-sm text-muted-foreground text-center">
              {t('agentSelector.noAgentsAvailable')}
            </div>
          ) : (
            agents.map(({ agentId, displayName, lifecycle, runnable }) =>
              runnable ? (
                <DropdownMenuItem
                  key={agentId}
                  onSelect={() => {
                    onChange({ executor: agentId, variant: null });
                  }}
                  className={selectedAgent === agentId ? 'bg-accent' : ''}
                >
                  <span className="flex items-center gap-2">
                    <AgentIcon agent={agentId} className="h-3.5 w-3.5" />
                    {displayName}
                  </span>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  key={agentId}
                  disabled
                  className="justify-between"
                  title={t(unavailableAgentStatusKey(lifecycle))}
                >
                  <span className="flex items-center gap-2">
                    <AgentIcon agent={agentId} className="h-3.5 w-3.5" />
                    {displayName}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {t(unavailableAgentStatusKey(lifecycle))}
                  </span>
                </DropdownMenuItem>
              )
            )
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => void settingsWindowApi.open()}
            className="text-muted-foreground"
          >
            <span className="flex items-center gap-2">
              <Settings2 className="h-3.5 w-3.5" />
              {t('agentSelector.manageAgents')}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
