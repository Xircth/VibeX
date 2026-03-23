import { Bot, ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import type { ExecutorProfileId, BaseCodingAgent } from 'shared/types';
import { isSupportedAgent, AGENT_DISPLAY_NAMES } from '@/constants/agents';

interface AgentSelectorProps {
  profiles: Record<string, Record<string, unknown>> | null;
  selectedExecutorProfile: ExecutorProfileId | null;
  onChange: (profile: ExecutorProfileId) => void;
  disabled?: boolean;
  className?: string;
  showLabel?: boolean;
}

export function AgentSelector({
  profiles,
  selectedExecutorProfile,
  onChange,
  disabled,
  className = '',
  showLabel = false,
}: AgentSelectorProps) {
  const agents = profiles
    ? (Object.keys(profiles)
        .filter(isSupportedAgent)
        .sort() as BaseCodingAgent[])
    : [];
  const selectedAgent = selectedExecutorProfile?.executor;

  if (!profiles) return null;

  return (
    <div className={showLabel ? 'flex flex-col w-full' : 'flex-1'}>
      {showLabel && (
        <Label htmlFor="executor-profile" className="text-sm font-medium">
          Agent
        </Label>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={`w-full justify-between text-xs ${showLabel ? 'mt-1.5' : ''} ${className}`}
            disabled={disabled}
            aria-label="选择代理"
          >
            <div className="flex items-center gap-1.5 w-full">
              <Bot className="h-3 w-3" />
              <span className="truncate">{selectedAgent || 'Agent'}</span>
            </div>
            <ArrowDown className="h-3 w-3" />
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
                {(AGENT_DISPLAY_NAMES as Record<string, string>)[agent] ?? agent}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
