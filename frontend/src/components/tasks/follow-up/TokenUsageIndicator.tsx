import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
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
  if (
    !tokenUsageInfo ||
    tokenUsageInfo.model_context_window <= 0 ||
    tokenUsageInfo.total_tokens <= 0
  )
    return null;

  const usedTokens = tokenUsageInfo.total_tokens;
  const contextWindow = tokenUsageInfo.model_context_window;
  const percentage = Math.min(
    100,
    Math.max(
      0,
      Math.round((usedTokens / contextWindow) * 100)
    )
  );
  const ringStyle = {
    background: [
      'conic-gradient(',
      `var(--composer-token-usage-ring, hsl(var(--foreground))) ${percentage}%, `,
      `var(--composer-token-usage-track, hsl(var(--muted))) ${percentage}% 100%)`,
    ].join(''),
  };
  const coreStyle = {
    backgroundColor:
      'var(--composer-token-usage-core, hsl(var(--background)))',
  };
  const usedLabel = usedTokens.toLocaleString();
  const windowLabel = contextWindow.toLocaleString();
  const ariaLabel = `\u4e0a\u4e0b\u6587\u5360\u7528 ${percentage}%\uff0c${usedLabel} / ${windowLabel} tokens`;

  return (
    // Self-contained provider: this indicator is also mounted outside the
    // composer (e.g. the status bar ring), where no ancestor TooltipProvider
    // exists. Nested Radix providers are harmless.
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="composer-control inline-flex h-5 w-5 shrink-0 cursor-default items-center justify-center rounded-full p-0"
            aria-label={ariaLabel}
            title={ariaLabel}
          >
            <span
              className="composer-token-usage-ring inline-flex h-4 w-4 items-center justify-center rounded-full"
              style={ringStyle}
              aria-hidden="true"
            >
              <span
                className="composer-token-usage-core h-2.5 w-2.5 rounded-full"
                style={coreStyle}
              />
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {'\u4e0a\u4e0b\u6587\u5360\u7528'}
          {': '}
          {percentage}% - {usedLabel} / {windowLabel} tokens
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
