import { AgentIcon } from '@/components/agents/AgentIcon';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { ExecutorProfileId } from 'shared/types';

interface DiffStatsBarProps {
  executorProfile: ExecutorProfileId | null;
  sessionExecutor?: string | null;
}

export function DiffStatsBar({
  executorProfile,
  sessionExecutor,
}: DiffStatsBarProps) {
  if (!executorProfile?.executor) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center justify-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5">
          <AgentIcon
            agent={executorProfile.executor}
            className="h-3.5 w-3.5"
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        当前终端：{sessionExecutor ?? executorProfile.executor}
      </TooltipContent>
    </Tooltip>
  );
}
