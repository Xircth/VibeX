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
  diffSummary: {
    fileCount: number;
    added: number;
    deleted: number;
  };
}

export function DiffStatsBar({
  executorProfile,
  sessionExecutor,
  diffSummary,
}: DiffStatsBarProps) {
  return (
    <>
      {executorProfile?.executor && (
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
      )}

      {diffSummary.fileCount > 0 && (
        <>
          <span>{diffSummary.fileCount} 个文件已更改</span>
          <span className="text-green-600">+{diffSummary.added}</span>
          <span className="text-red-600">-{diffSummary.deleted}</span>
        </>
      )}
    </>
  );
}
