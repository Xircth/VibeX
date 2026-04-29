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
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useGitDiffNavigationStore } from '@/stores/useGitDiffNavigationStore';
import ProcessChangeFileRenderer from './ProcessChangeFileRenderer';

export type ProcessChangeItem = {
  key: string;
  path: string;
  change: FileChange;
};

export type ProcessChangeFileGroup = {
  key: string;
  path: string;
  items: ProcessChangeItem[];
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

export function buildProcessChangeFileGroups(
  changes: ProcessChangeItem[]
): ProcessChangeFileGroup[] {
  const groups = new Map<string, ProcessChangeFileGroup>();

  for (const item of changes) {
    const existing = groups.get(item.path);
    if (existing) {
      existing.items.push(item);
      continue;
    }

    groups.set(item.path, {
      key: item.key,
      path: item.path,
      items: [item],
    });
  }

  return Array.from(groups.values());
}

function estimateGroupStats(group: ProcessChangeFileGroup): {
  additions: number;
  deletions: number;
} {
  return group.items.reduce(
    (total, item) => {
      const stats = estimateChangeStats(item.change);
      return {
        additions: total.additions + stats.additions,
        deletions: total.deletions + stats.deletions,
      };
    },
    { additions: 0, deletions: 0 }
  );
}

function ProcessChangeFileGroupRenderer({
  executionProcessId,
  group,
  containerRef,
}: {
  executionProcessId: string;
  group: ProcessChangeFileGroup;
  containerRef?: string | null;
}) {
  const [expanded, setExpanded] = useExpandable(
    `process-summary-file-group:${executionProcessId}:${group.key}`,
    false
  );
  const { openDiffPreview } = usePanelActionsContext();
  const focusDiffPath = useGitDiffNavigationStore((state) => state.focusPath);
  const stats = useMemo(() => estimateGroupStats(group), [group]);

  if (group.items.length === 1) {
    const item = group.items[0]!;
    return (
      <ProcessChangeFileRenderer
        key={item.key}
        path={item.path}
        change={item.change}
        expansionKey={`process-summary:${executionProcessId}:${item.key}`}
        containerRef={containerRef}
      />
    );
  }

  return (
    <div>
      <button
        type="button"
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/40"
        onClick={() => setExpanded()}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          <span
            className="hover:text-primary hover:underline"
            onClick={(event) => {
              event.stopPropagation();
              openDiffPreview();
              focusDiffPath(group.path);
            }}
          >
            {group.path}
          </span>
        </span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {group.items.length} changes
        </span>
        <span className="font-mono text-xs text-green-600 dark:text-green-400">
          +{stats.additions}
        </span>
        <span className="font-mono text-xs text-red-600 dark:text-red-400">
          -{stats.deletions}
        </span>
      </button>

      {expanded && (
        <div className="ml-5 border-l border-border/60 pl-2">
          {group.items.map((item) => (
            <ProcessChangeFileRenderer
              key={item.key}
              path={item.path}
              change={item.change}
              expansionKey={`process-summary:${executionProcessId}:${item.key}`}
              containerRef={containerRef}
            />
          ))}
        </div>
      )}
    </div>
  );
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
  const fileGroups = useMemo(
    () => buildProcessChangeFileGroups(changes),
    [changes]
  );

  const greyed = isProcessGreyed(executionProcessId);
  const [expanded, setExpanded] = useExpandable(
    `process-summary-card:${executionProcessId}`,
    !(processChangeConfig?.files_changed_default_collapsed ?? false)
  );

  const { fileCount, additions, deletions } = useMemo(() => {
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const group of fileGroups) {
      const stats = estimateGroupStats(group);
      totalAdditions += stats.additions;
      totalDeletions += stats.deletions;
    }

    return {
      fileCount: fileGroups.length,
      additions: totalAdditions,
      deletions: totalDeletions,
    };
  }, [fileGroups]);

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

  if (fileGroups.length === 0) {
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
            {fileGroups.map((group) => (
              <ProcessChangeFileGroupRenderer
                key={group.key}
                executionProcessId={executionProcessId}
                group={group}
                containerRef={attempt.container_ref}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
