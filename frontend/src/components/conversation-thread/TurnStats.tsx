import { useCallback, type ComponentType } from 'react';
import {
  Check,
  Clock3,
  Copy,
  CornerUpLeft,
  Cpu,
  Database,
  Gauge,
  Timer,
} from 'lucide-react';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { cn } from '@/lib/utils';
import type { TurnStatsData } from './turnStatsModel';

export type TurnStatsProps = {
  stats?: TurnStatsData | null;
  copyText?: string | null;
  onJumpBack?: (() => void) | null;
  live?: boolean;
  className?: string;
};

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatTokenCount(value: number | null | undefined): string | null {
  if (!isFiniteNumber(value)) return null;
  return Math.max(0, Math.floor(value)).toLocaleString();
}

export function formatTurnDuration(ms: number | null | undefined): string | null {
  if (!isFiniteNumber(ms)) return null;

  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

export function formatCompletionTime(
  timestamp: string | null | undefined
): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;

  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function StatItem({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <span className="conv-turn-stat-item" title={`${label}: ${value}`}>
      <Icon className="h-3.5 w-3.5" />
      <span className="conv-turn-stat-label">{label}</span>
      <span className="conv-turn-stat-value">{value}</span>
    </span>
  );
}

export function TurnStats({
  stats,
  copyText,
  onJumpBack,
  live = false,
  className,
}: TurnStatsProps) {
  const [copied, triggerCopied] = useTemporaryFlag(1600);
  const hasCopy = Boolean(copyText?.trim());
  const tokenText = (() => {
    const totalTokens = formatTokenCount(stats?.totalTokens);
    if (!totalTokens) return null;

    const contextWindow = formatTokenCount(stats?.contextWindow);
    return contextWindow ? `${totalTokens} / ${contextWindow}` : totalTokens;
  })();
  const cacheReadText = formatTokenCount(stats?.cacheReadTokens);
  const cacheWriteText = formatTokenCount(stats?.cacheWriteTokens);
  const elapsedText = formatTurnDuration(stats?.elapsedMs);
  const completedAtText = formatCompletionTime(stats?.completedAt);
  const modelText = stats?.model?.trim() || null;
  const stopReasonText = stats?.stopReason?.trim() || null;
  const hasStats = Boolean(
    modelText ||
      tokenText ||
      cacheReadText ||
      cacheWriteText ||
      elapsedText ||
      completedAtText ||
      stopReasonText ||
      live
  );

  const handleCopy = useCallback(async () => {
    if (!copyText) return;

    try {
      await navigator.clipboard.writeText(copyText);
      triggerCopied();
    } catch {
      // Clipboard API can be unavailable in embedded webviews.
    }
  }, [copyText, triggerCopied]);

  if (!hasCopy && !onJumpBack && !hasStats) {
    return null;
  }

  return (
    <div className={cn('conv-turn-stats px-4', className)}>
      <div className="conv-turn-stats-row">
        <div className="conv-turn-stats-actions">
          {hasCopy ? (
            <button
              type="button"
              className="conv-turn-stat-button"
              onClick={handleCopy}
              aria-label="复制回复"
              title="复制回复"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
          {onJumpBack ? (
            <button
              type="button"
              className="conv-turn-stat-button"
              onClick={onJumpBack}
              aria-label="回到上一条用户消息"
              title="回到上一条用户消息"
            >
              <CornerUpLeft className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        <div className="conv-turn-stats-items">
          {live ? (
            <StatItem icon={Gauge} label="状态" value="生成中" />
          ) : null}
          {modelText ? (
            <StatItem icon={Cpu} label="模型" value={modelText} />
          ) : null}
          {tokenText ? (
            <StatItem icon={Gauge} label="Token" value={tokenText} />
          ) : null}
          {cacheReadText ? (
            <StatItem icon={Database} label="缓存读" value={cacheReadText} />
          ) : null}
          {cacheWriteText ? (
            <StatItem icon={Database} label="缓存写" value={cacheWriteText} />
          ) : null}
          {elapsedText ? (
            <StatItem icon={Timer} label="耗时" value={elapsedText} />
          ) : null}
          {completedAtText ? (
            <StatItem icon={Clock3} label="完成" value={completedAtText} />
          ) : null}
          {stopReasonText ? (
            <StatItem icon={Check} label="结束" value={stopReasonText} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

