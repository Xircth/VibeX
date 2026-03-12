import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface TokenUsageIndicatorProps {
  tokenUsageInfo: {
    total_tokens: number;
    model_context_window: number;
  } | null;
}

export function TokenUsageIndicator({
  tokenUsageInfo,
}: TokenUsageIndicatorProps) {
  if (!tokenUsageInfo) return null;

  const percentage = Math.round(
    (tokenUsageInfo.total_tokens / tokenUsageInfo.model_context_window) * 100
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default tabular-nums rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5">
          {percentage}%
        </span>
      </TooltipTrigger>
      <TooltipContent>
        实际占用：{Math.round(tokenUsageInfo.total_tokens / 1000)}k /{' '}
        {Math.round(tokenUsageInfo.model_context_window / 1000)}k tokens
      </TooltipContent>
    </Tooltip>
  );
}
