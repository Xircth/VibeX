import { useCallback, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Clock3,
  Copy,
  CornerUpLeft,
  Gauge,
  GitFork,
  Timer,
} from 'lucide-react';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { cn } from '@/lib/utils';
import { asFiniteNumber, type TurnStatsData } from './turnStatsModel';

export type TurnStatsProps = {
  stats?: TurnStatsData | null;
  copyText?: string | null;
  onJumpBack?: (() => void) | null;
  onForkFromHere?: (() => void) | null;
  forkDisabled?: boolean;
  forkDisabledReason?: 'busy' | 'unnamed';
  live?: boolean;
  className?: string;
};

export function formatTokenCount(value: unknown): string | null {
  const tokens = asFiniteNumber(value);
  if (tokens === null) return null;
  const count = Math.max(0, Math.floor(tokens));
  if (count <= 0) return null;
  return count.toLocaleString();
}

export function formatTurnDuration(ms: unknown): string | null {
  const duration = asFiniteNumber(ms);
  if (duration === null) return null;

  const seconds = Math.max(0, Math.floor(duration / 1000));
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
  hideLabel = false,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hideLabel?: boolean;
}) {
  return (
    <span className="conv-turn-stat-item" title={`${label}: ${value}`}>
      <Icon className="h-3.5 w-3.5" />
      {hideLabel ? null : <span className="conv-turn-stat-label">{label}</span>}
      <span className="conv-turn-stat-value">{value}</span>
    </span>
  );
}

export function TurnStats({
  stats,
  copyText,
  onJumpBack,
  onForkFromHere,
  forkDisabled = false,
  forkDisabledReason = 'busy',
  live = false,
  className,
}: TurnStatsProps) {
  const { t } = useTranslation(['conversation', 'common']);
  const [copied, triggerCopied] = useTemporaryFlag(1600);
  const [showCompletedAt, setShowCompletedAt] = useState(false);
  const hasCopy = Boolean(copyText?.trim());
  const tokenText = formatTokenCount(stats?.totalTokens);
  const elapsedText = formatTurnDuration(stats?.elapsedMs);
  const completedAtText = formatCompletionTime(stats?.completedAt);
  const stopReasonText = stats?.stopReason?.trim() || null;
  const hasStats = Boolean(
    live || tokenText || elapsedText || completedAtText || stopReasonText
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

  if (!hasCopy && !onJumpBack && !onForkFromHere && !hasStats) {
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
              aria-label={t('turnStats.copyReply')}
              title={t('turnStats.copyReply')}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
          {onForkFromHere ? (
            <button
              type="button"
              className={cn(
                'conv-turn-stat-button',
                forkDisabled &&
                  'cursor-not-allowed opacity-50 hover:bg-transparent'
              )}
              onClick={forkDisabled ? undefined : onForkFromHere}
              aria-disabled={forkDisabled || undefined}
              aria-label={t('turnStats.forkFromHere')}
              title={
                forkDisabled
                  ? forkDisabledReason === 'unnamed'
                    ? t('turnStats.forkUnnamed')
                    : t('turnStats.forkBusy')
                  : t('turnStats.forkFromHere')
              }
            >
              <GitFork className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {onJumpBack ? (
            <button
              type="button"
              className="conv-turn-stat-button"
              onClick={onJumpBack}
              aria-label={t('turnStats.jumpBack')}
              title={t('turnStats.jumpBack')}
            >
              <CornerUpLeft className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        <div className="conv-turn-stats-items">
          {live ? (
            <StatItem
              icon={Gauge}
              label={t('turnStats.statusLabel')}
              value={t('turnStats.generating')}
            />
          ) : null}
          {tokenText ? (
            <StatItem icon={Gauge} label="Token" value={tokenText} />
          ) : null}
          {elapsedText ? (
            completedAtText ? (
              <button
                type="button"
                className="conv-turn-stat-item conv-turn-stat-elapsed"
                aria-expanded={showCompletedAt}
                aria-label={`${t('turnStats.elapsedLabel')} ${elapsedText}`}
                title={`${t('turnStats.elapsedLabel')}: ${elapsedText}`}
                onClick={() => setShowCompletedAt((open) => !open)}
              >
                <Timer className="h-3.5 w-3.5" />
                <span className="conv-turn-stat-value">{elapsedText}</span>
              </button>
            ) : (
              <StatItem
                icon={Timer}
                label={t('turnStats.elapsedLabel')}
                value={elapsedText}
                hideLabel
              />
            )
          ) : null}
          {showCompletedAt && completedAtText ? (
            <StatItem
              icon={Clock3}
              label={t('turnStats.completedLabel')}
              value={completedAtText}
              hideLabel
            />
          ) : null}
          {stopReasonText ? (
            <StatItem
              icon={Check}
              label={t('turnStats.stopReasonLabel')}
              value={stopReasonText}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
