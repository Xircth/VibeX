import { useState, type ReactNode } from 'react';
import type {
  ExecutorProfileId,
  Session,
  TokenUsageInfo,
} from 'shared/types';

import type { CodexGoalState } from '@/lib/codexGoalState';

import { DiffStatsBar } from './DiffStatsBar';
import { TokenUsageIndicator } from './TokenUsageIndicator';

interface SessionComposerTopbarProps {
  executorProfile: ExecutorProfileId | null;
  sessionExecutor?: Session['executor'] | null;
  showChangedFileSummary: boolean;
  changedFileCount: number;
  added: number;
  deleted: number;
  codexGoalState?: CodexGoalState | null;
  onSelectCodexGoal?: () => void;
  tokenUsageInfo: TokenUsageInfo | null;
  composerIdentity?: ReactNode;
}

export function SessionComposerTopbar({
  executorProfile,
  sessionExecutor,
  showChangedFileSummary,
  changedFileCount,
  added,
  deleted,
  tokenUsageInfo,
  composerIdentity,
}: SessionComposerTopbarProps) {
  const [showDiffStats, setShowDiffStats] = useState(false);

  return (
    <div className="composer-topbar flex items-center gap-2 px-1 pb-0 text-xs">
      {composerIdentity ?? (
        <DiffStatsBar
          executorProfile={executorProfile}
          sessionExecutor={sessionExecutor}
        />
      )}
      {showChangedFileSummary ? (
        <button
          type="button"
          onClick={() => setShowDiffStats((prev) => !prev)}
          className="composer-control inline-flex items-center rounded-md px-2 py-0.5 text-xs transition-colors"
        >
          {showDiffStats ? (
            <span className="inline-flex items-center gap-1.5 font-mono">
              <span className="text-[hsl(var(--success))]">+{added}</span>
              <span className="text-destructive">-{deleted}</span>
            </span>
          ) : (
            `${changedFileCount} CHANGES`
          )}
        </button>
      ) : null}

      <div className="flex-1" />

      <TokenUsageIndicator tokenUsageInfo={tokenUsageInfo} />
    </div>
  );
}
