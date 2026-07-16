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
import type { ExecutorProfileId, AgentKind } from 'shared/types';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
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
    // The backend's local-runtime gate is authoritative. Do not temporarily
    // promote profile-configured agents to "installed" while its query is in
    // flight: that used to let a user select a runtime that cannot create an
    // ACP session.
    const installedByAgent = new Map<AgentKind, boolean>();
    for (const item of selectable) {
      if (item.enabled) installedByAgent.set(item.agent, item.installed);
    }
    return Array.from(installedByAgent.entries())
      .map(([agent, installed]) => ({ agent, installed }))
      .sort((a, b) => a.agent.localeCompare(b.agent));
  }, [selectable]);
  const selectedAgent = selectedExecutorProfile?.executor;
  const selectedAgentLabel = selectedAgent
    ? getAgentName(selectedAgent)
    : 'Agent';

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
            {!iconOnly ? <ArrowDown className="h-3 w-3" /> : null}
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
            agents.map(({ agent, installed }) =>
              installed ? (
                <DropdownMenuItem
                  key={agent}
                  onSelect={() => {
                    onChange({ executor: agent, variant: null });
                  }}
                  className={selectedAgent === agent ? 'bg-accent' : ''}
                >
                  <span className="flex items-center gap-2">
                    <AgentIcon agent={agent} className="h-3.5 w-3.5" />
                    {getAgentName(agent)}
                  </span>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  key={agent}
                  disabled
                  className="justify-between"
                  title={t('agentSelector.notInstalledHint')}
                >
                  <span className="flex items-center gap-2">
                    <AgentIcon agent={agent} className="h-3.5 w-3.5" />
                    {getAgentName(agent)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {t('agentSelector.notInstalled')}
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
