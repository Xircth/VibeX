import { useState } from 'react';
import { ArrowUp } from 'lucide-react';
import type {
  ExecutorProfileId,
  Session,
  TodoItem,
  TokenUsageInfo,
} from 'shared/types';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { UseWorkspaceSessionsResult } from '@/hooks/useWorkspaceSessions';
import type { CodexGoalState } from '@/lib/codexGoalState';

import { CodexGoalIndicator } from './CodexGoalIndicator';
import { DiffStatsBar } from './DiffStatsBar';
import { SessionSelector } from './SessionSelector';
import { TodoListButton } from './TodoListButton';
import { TokenUsageIndicator } from './TokenUsageIndicator';

interface SessionComposerTopbarProps {
  executorProfile: ExecutorProfileId | null;
  sessionExecutor?: Session['executor'] | null;
  showChangedFileSummary: boolean;
  changedFileCount: number;
  added: number;
  deleted: number;
  codexGoalState: CodexGoalState | null;
  tokenUsageInfo: TokenUsageInfo | null;
  todos: TodoItem[];
  showSessionSelector: boolean;
  sessions: UseWorkspaceSessionsResult['sessions'];
  selectedSessionId?: string;
  compactSessionLabel: string;
  selectedSessionLabel: string;
  onJumpToPreviousUserMessage?: () => void;
  onSelectSession: (id: string) => void;
  onStartNewSession: () => void;
  onRenameSession: (id: string, name: string | null) => void | Promise<void>;
}

const JUMP_TO_PREVIOUS_LABEL =
  '\u56de\u5230\u4e0a\u4e00\u6761\u7528\u6237\u6d88\u606f';

export function SessionComposerTopbar({
  executorProfile,
  sessionExecutor,
  showChangedFileSummary,
  changedFileCount,
  added,
  deleted,
  codexGoalState,
  tokenUsageInfo,
  todos,
  showSessionSelector,
  sessions,
  selectedSessionId,
  compactSessionLabel,
  selectedSessionLabel,
  onJumpToPreviousUserMessage,
  onSelectSession,
  onStartNewSession,
  onRenameSession,
}: SessionComposerTopbarProps) {
  const [showDiffStats, setShowDiffStats] = useState(false);

  return (
    <div className="composer-topbar flex items-center gap-2 px-1 pb-0 text-xs">
      <DiffStatsBar
        executorProfile={executorProfile}
        sessionExecutor={sessionExecutor}
      />
      {showChangedFileSummary ? (
        <button
          type="button"
          onClick={() => setShowDiffStats((prev) => !prev)}
          className="composer-control inline-flex items-center rounded-md px-2 py-0.5 text-[11px] transition-colors"
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

      <CodexGoalIndicator goalState={codexGoalState} />

      <TokenUsageIndicator tokenUsageInfo={tokenUsageInfo} />

      <TodoListButton todos={todos} />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onJumpToPreviousUserMessage}
            className="composer-icon-control flex items-center justify-center rounded-md px-1.5 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={JUMP_TO_PREVIOUS_LABEL}
            disabled={!onJumpToPreviousUserMessage}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{JUMP_TO_PREVIOUS_LABEL}</TooltipContent>
      </Tooltip>

      {showSessionSelector ? (
        <SessionSelector
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          compactSessionLabel={compactSessionLabel}
          selectedSessionLabel={selectedSessionLabel}
          onSelectSession={onSelectSession}
          onStartNewSession={onStartNewSession}
          onRenameSession={onRenameSession}
          dropdownSide="top"
        />
      ) : null}
    </div>
  );
}
