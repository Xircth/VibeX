import { Bot, ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ExecutorProfileId, BaseCodingAgent } from 'shared/types';
import { isSupportedAgent, AGENT_DISPLAY_NAMES } from '@/constants/agents';
import { AgentIcon } from '@/components/agents/AgentIcon';

interface AgentSelectorProps {
  profiles: Record<string, Record<string, unknown>> | null;
  selectedExecutorProfile: ExecutorProfileId | null;
  onChange: (profile: ExecutorProfileId) => void;
  disabled?: boolean;
  className?: string;
  iconOnly?: boolean;
}

export function AgentSelector({
  profiles,
  selectedExecutorProfile,
  onChange,
  disabled,
  className = '',
  iconOnly = false,
}: AgentSelectorProps) {
  const agents = profiles
    ? (Object.keys(profiles)
        .filter(isSupportedAgent)
        .sort() as BaseCodingAgent[])
    : [];
  const selectedAgent = selectedExecutorProfile?.executor;
  const selectedAgentLabel = selectedAgent
    ? (AGENT_DISPLAY_NAMES as Record<string, string>)[selectedAgent] ??
      selectedAgent
    : 'Agent';

  if (!profiles) return null;

  return (
    <div className={iconOnly ? 'shrink-0' : 'flex-1'}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={iconOnly ? 'ghost' : 'outline'}
            size="sm"
            className={`${iconOnly ? 'h-7 w-7 px-0 justify-center gap-0 border-0 shadow-none' : 'w-full justify-between'} text-xs ${className}`}
            disabled={disabled}
            aria-label="选择代理"
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
        <DropdownMenuContent className="w-60">
          {agents.length === 0 ? (
            <div className="p-2 text-sm text-muted-foreground text-center">
              暂无可用代理
            </div>
          ) : (
            agents.map((agent) => (
              <DropdownMenuItem
                key={agent}
                onClick={() => {
                  onChange({
                    executor: agent,
                    variant: null,
                  });
                }}
                className={selectedAgent === agent ? 'bg-accent' : ''}
              >
                <span className="flex items-center gap-2">
                  <AgentIcon agent={agent} className="h-3.5 w-3.5" />
                  {(AGENT_DISPLAY_NAMES as Record<string, string>)[agent] ??
                    agent}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
