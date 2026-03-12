import { useCallback, useEffect } from 'react';
import { GitBranch, History } from 'lucide-react';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import {
  useGitStatus,
  useGitDiffs,
  shouldAutoPreloadDiffs,
  useGitLog,
  useGitActions,
  useGitCommit,
  useGitPanelController,
} from '@/hooks/git';
import { GitStagingArea } from './GitStagingArea';
import { GitCommitBox } from './GitCommitBox';
import { GitDiffViewer } from './GitDiffViewer';
import { GitLogView } from './GitLogView';

function EmptyState() {
  return (
    <div className="h-full w-full flex items-center justify-center text-muted-foreground text-sm">
      <div className="text-center space-y-2">
        <GitBranch className="h-8 w-8 opacity-40 mx-auto" />
        <p className="font-medium">Git Manager</p>
        <p className="text-xs">Select a workspace to view Git status</p>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="h-full w-full flex items-center justify-center text-muted-foreground text-xs">
      Loading Git status...
    </div>
  );
}

export function GitPanel() {
  const { activeWorktreeId } = useWorktree();
  const { selectedRepoId } = useAttemptRepo(activeWorktreeId ?? undefined);

  const workspaceId = activeWorktreeId ?? null;
  const repoId = selectedRepoId ?? null;

  const {
    mode,
    setMode,
    diffViewStyle,
    toggleDiffViewStyle,
    selectedDiffPath,
    setSelectedDiffPath,
  } = useGitPanelController();

  const {
    branchName,
    stagedFiles,
    unstagedFiles,
    totalAdditions,
    totalDeletions,
    isLoading: statusLoading,
    refresh: refreshStatus,
  } = useGitStatus({ workspaceId, repoId });

  const {
    stageFile,
    unstageFile,
    revertFile,
    stageAll,
    revertAll,
  } = useGitActions({ workspaceId, repoId, onSuccess: refreshStatus });

  const {
    diffs,
    refresh: refreshDiffs,
  } = useGitDiffs({ workspaceId, repoId });

  useEffect(() => {
    if (mode === 'diff' && shouldAutoPreloadDiffs(stagedFiles, unstagedFiles)) {
      refreshDiffs();
    }
  }, [mode, stagedFiles, unstagedFiles, refreshDiffs]);

  const {
    commitMessage,
    setCommitMessage,
    commitLoading,
    pushLoading,
    commitError,
    pushError,
    onCommit,
    onCommitAndPush,
  } = useGitCommit({
    workspaceId,
    repoId,
    onSuccess: refreshStatus,
  });

  const gitLog = useGitLog({
    workspaceId,
    repoId,
    enabled: mode === 'log',
  });

  const handleSelectFile = useCallback(
    (path: string) => {
      setSelectedDiffPath(path === selectedDiffPath ? null : path);
      if (diffs.length === 0) {
        refreshDiffs();
      }
    },
    [selectedDiffPath, setSelectedDiffPath, diffs.length, refreshDiffs]
  );

  const handleRevertAll = useCallback(() => {
    if (window.confirm('Discard all unstaged changes? This cannot be undone.')) {
      revertAll();
    }
  }, [revertAll]);

  if (!activeWorktreeId) return <EmptyState />;
  if (statusLoading && !branchName) return <LoadingState />;

  return (
    <div className="h-full w-full flex flex-col bg-background overflow-hidden" data-panel="git">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-1 text-xs text-foreground mr-1">
          <GitBranch className="h-3 w-3 text-muted-foreground" />
          <span className="font-mono font-medium truncate max-w-[120px]">{branchName}</span>
        </div>

        {(totalAdditions > 0 || totalDeletions > 0) && (
          <span className="text-[10px] font-mono shrink-0">
            {totalAdditions > 0 && <span className="text-green-500">+{totalAdditions}</span>}
            {totalAdditions > 0 && totalDeletions > 0 && <span className="text-muted-foreground">/</span>}
            {totalDeletions > 0 && <span className="text-red-500">-{totalDeletions}</span>}
          </span>
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-0.5 text-[10px]">
          <button
            className={`px-1.5 py-0.5 rounded transition-colors ${
              mode === 'diff'
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setMode('diff')}
          >
            Diff
          </button>
          <button
            className={`px-1.5 py-0.5 rounded transition-colors flex items-center gap-0.5 ${
              mode === 'log'
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setMode('log')}
          >
            <History className="h-3 w-3" />
            Log
          </button>
        </div>

      </div>

      {mode === 'diff' && (
        <div className="flex flex-col flex-1 min-h-0">
          <GitCommitBox
            commitMessage={commitMessage}
            onCommitMessageChange={setCommitMessage}
            hasStagedFiles={stagedFiles.length > 0}
            hasUnstagedFiles={unstagedFiles.length > 0}
            commitLoading={commitLoading}
            pushLoading={pushLoading}
            commitError={commitError}
            pushError={pushError}
            commitsAhead={gitLog.ahead}
            onCommit={onCommit}
            onCommitAndPush={onCommitAndPush}
          />

          <div className="flex flex-1 min-h-0">
            <div className="w-full flex flex-col min-h-0 overflow-y-auto">
              <GitStagingArea
                stagedFiles={stagedFiles}
                unstagedFiles={unstagedFiles}
                selectedPath={selectedDiffPath}
                onSelectFile={handleSelectFile}
                onStageFile={stageFile}
                onUnstageFile={unstageFile}
                onRevertFile={revertFile}
                onStageAll={stageAll}
                onRevertAll={handleRevertAll}
              />
            </div>
          </div>

          {selectedDiffPath && diffs.length > 0 && (
            <div className="border-t border-border/30 flex-1 min-h-[200px] max-h-[50%]">
              <GitDiffViewer
                diffs={diffs}
                selectedPath={selectedDiffPath}
                diffStyle={diffViewStyle}
                onToggleDiffStyle={toggleDiffViewStyle}
              />
            </div>
          )}
        </div>
      )}

      {mode === 'log' && (
        <GitLogView
          entries={gitLog.entries}
          total={gitLog.total}
          ahead={gitLog.ahead}
          behind={gitLog.behind}
          upstream={gitLog.upstream}
          branchName={gitLog.branchName || branchName}
          loading={gitLog.isLoading}
        />
      )}
    </div>
  );
}
