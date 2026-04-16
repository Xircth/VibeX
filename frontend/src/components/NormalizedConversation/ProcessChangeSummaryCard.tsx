import { useCallback, useMemo, useState } from 'react';
import { ChevronRight, Undo2 } from 'lucide-react';
import type { FileChange } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { useAttemptExecution } from '@/hooks/useAttemptExecution';
import { useBranchStatus } from '@/hooks/useBranchStatus';
import { Button } from '@/components/ui/button';
import { sessionsApi } from '@/lib/api';
import { RestoreLogsDialog } from '@/components/dialogs';
import { parseDiffStats } from '@/utils/diffStatsParser';
import { cn } from '@/lib/utils';
import { useRetryUi } from '@/contexts/RetryUiContext';
import { useExpandable } from '@/stores/useExpandableStore';
import { useUserSystem } from '@/components/ConfigProvider';
import ProcessChangeFileRenderer from './ProcessChangeFileRenderer';

export type ProcessChangeItem = {
  key: string;
  path: string;
  change: FileChange;
};

type ProcessChangeConfig = {
  files_changed_default_collapsed?: boolean;
};

function estimateChangeStats(change: FileChange): {
  additions: number;
  deletions: number;
} {
  switch (change.action) {
    case 'edit':
      return parseDiffStats(change.unified_diff);
    case 'write': {
      const lineCount =
        change.content.length === 0 ? 0 : change.content.split(/\r?\n/).length;
      return { additions: lineCount, deletions: 0 };
    }
    case 'delete':
      return { additions: 0, deletions: 1 };
    case 'rename':
      return { additions: 0, deletions: 0 };
    default:
      return { additions: 0, deletions: 0 };
  }
}

export function ProcessChangeSummaryCard({
  executionProcessId,
  attempt,
  changes,
}: {
  executionProcessId: string;
  attempt: WorkspaceWithSession;
  changes: ProcessChangeItem[];
}) {
  const [isRollingBack, setIsRollingBack] = useState(false);
  const { isAttemptRunning, attemptData } = useAttemptExecution(attempt.id);
  const { data: branchStatus } = useBranchStatus(attempt.id);
  const { isProcessGreyed } = useRetryUi();
  const { config } = useUserSystem();
  const processChangeConfig = config as ProcessChangeConfig | null;

  const greyed = isProcessGreyed(executionProcessId);
  const [expanded, setExpanded] = useExpandable(
    `process-summary-card:${executionProcessId}`,
    !(processChangeConfig?.files_changed_default_collapsed ?? false)
  );

  const { fileCount, additions, deletions } = useMemo(() => {
    const uniqueFiles = new Set<string>();
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const item of changes) {
      uniqueFiles.add(item.path);
      const stats = estimateChangeStats(item.change);
      totalAdditions += stats.additions;
      totalDeletions += stats.deletions;
    }

    return {
      fileCount: uniqueFiles.size,
      additions: totalAdditions,
      deletions: totalDeletions,
    };
  }, [changes]);

  const handleRollback = useCallback(async () => {
    if (!attempt.session?.id) return;

    setIsRollingBack(true);
    try {
      let modalResult;
      try {
        modalResult = await RestoreLogsDialog.show({
          executionProcessId,
          branchStatus,
          processes: attemptData.processes,
          mode: 'reset',
        });
      } catch {
        return;
      }

      if (!modalResult || modalResult.action !== 'confirmed') return;

      await sessionsApi.reset(attempt.session.id, {
        process_id: executionProcessId,
        force_when_dirty: modalResult.forceWhenDirty ?? false,
        perform_git_reset: modalResult.performGitReset ?? true,
      });
    } catch (error) {
      console.error('Failed to rollback process changes:', error);
    } finally {
      setIsRollingBack(false);
    }
  }, [
    attempt.session?.id,
    attemptData.processes,
    branchStatus,
    executionProcessId,
  ]);

  if (changes.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        'px-4 py-2 conv-entry-item',
        greyed && 'opacity-50 pointer-events-none'
      )}
    >
      <div className="overflow-hidden rounded-md border border-border bg-background">
        <div className="flex items-center gap-3 px-3 py-2 text-sm">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => setExpanded()}
          >
            <ChevronRight
              className={cn(
                'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                expanded && 'rotate-90'
              )}
            />
            <div className="min-w-0 flex-1">
              <span className="font-medium">{fileCount} files changed</span>
              <span className="ml-2 text-green-600 dark:text-green-400">
                +{additions}
              </span>
              <span className="ml-1 text-red-600 dark:text-red-400">
                -{deletions}
              </span>
            </div>
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2"
            onClick={handleRollback}
            disabled={isRollingBack || isAttemptRunning || !attempt.session?.id}
          >
            <Undo2 className="h-3.5 w-3.5" />
            <span>Undo</span>
          </Button>
        </div>

        {expanded && (
          <div className="px-2 pb-2">
            {changes.map((item) => (
              <ProcessChangeFileRenderer
                key={item.key}
                path={item.path}
                change={item.change}
                expansionKey={`process-summary:${executionProcessId}:${item.key}`}
                containerRef={attempt.container_ref}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
