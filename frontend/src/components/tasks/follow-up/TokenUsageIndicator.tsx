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
  if (!tokenUsageInfo || tokenUsageInfo.model_context_window <= 0) return null;

  const percentage = Math.min(
    100,
    Math.max(
      0,
      Math.round(
        (tokenUsageInfo.total_tokens / tokenUsageInfo.model_context_window) *
          100
      )
    )
  );
  const ringStyle = {
    background: `conic-gradient(#111827 ${percentage}%, hsl(var(--muted)) ${percentage}% 100%)`,
  };
  const ariaLabel = `\u4e0a\u4e0b\u6587\u5360\u7528 ${percentage}%`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex h-4 w-4 shrink-0 cursor-default items-center justify-center rounded-full"
          aria-label={ariaLabel}
          title={ariaLabel}
          style={ringStyle}
        >
          <span className="h-2.5 w-2.5 rounded-full bg-background" />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {'\u4e0a\u4e0b\u6587\u5360\u7528'}
        {': '}
        {percentage}% - {Math.round(tokenUsageInfo.total_tokens / 1000)}k /{' '}
        {Math.round(tokenUsageInfo.model_context_window / 1000)}k tokens
      </TooltipContent>
    </Tooltip>
  );
}
