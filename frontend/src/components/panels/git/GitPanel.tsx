import { useCallback, useEffect } from 'react';
import {
  GitBranch,
  History,
  ArrowLeftRight,
  Download,
  RefreshCw,
  Loader2,
  GitBranchPlus,
  GitPullRequest,
  CircleDot,
  LayoutList,
  FolderTree,
} from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useAttempt } from '@/hooks/useAttempt';
import { useProjectRepos } from '@/hooks';
import {
  useGitStatus,
  useGitDiffs,
  shouldAutoPreloadDiffs,
  useGitLog,
  useGitActions,
  useGitCommit,
  useGitBranches,
  useGitHubData,
  useGitPanelController,
} from '@/hooks/git';
import { GitStagingArea } from './GitStagingArea';
import { GitCommitBox } from './GitCommitBox';
import { GitLogView } from './GitLogView';
import { GitBranchList } from './GitBranchList';
import { GitIssuesView } from './GitIssuesView';
import { GitPRsView } from './GitPRsView';
import { usePanelActions } from '@/hooks/usePanelActions';
import { useGitDiffNavigationStore } from '@/stores/useGitDiffNavigationStore';

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
  const { openDiffPreview } = usePanelActions();
  const focusDiffPath = useGitDiffNavigationStore((state) => state.focusPath);
  const { activeWorktreeId } = useWorktree();
  const { workspaceId: routeWorkspaceId, projectId } = useParams<{
    workspaceId?: string;
    projectId?: string;
  }>();
  const effectiveWorkspaceId = activeWorktreeId ?? routeWorkspaceId ?? null;
  const { data: workspace } = useAttempt(effectiveWorkspaceId ?? undefined);
  const { selectedRepoId } = useAttemptRepo(effectiveWorkspaceId ?? undefined);

  // When no workspace is active, fall back to the project's first repo
  const { data: projectRepos = [] } = useProjectRepos(projectId, {
    enabled: !effectiveWorkspaceId && !!projectId,
  });
  const fallbackRepoId = projectRepos[0]?.id ?? null;

  const workspaceId = effectiveWorkspaceId;
  const repoId = selectedRepoId ?? fallbackRepoId;
  const {
    mode,
    setMode,
    diffListView,
    toggleDiffListView,
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
  const displayedBranchName = workspace?.branch || branchName;

  const { stageFile, unstageFile, revertFile, stageAll, revertAll } =
    useGitActions({ workspaceId, repoId, onSuccess: refreshStatus });

  const { diffs, refresh: refreshDiffs } = useGitDiffs({ workspaceId, repoId });

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
    pullLoading,
    fetchLoading,
    commitError,
    operationError,
    onCommit,
    onCommitAndPush,
    onPush,
    onPull,
    onFetch,
  } = useGitCommit({
    workspaceId,
    repoId,
    onSuccess: refreshStatus,
  });

  const gitLog = useGitLog({
    workspaceId,
    repoId,
    enabled: mode === 'log' || mode === 'diff',
  });

  const gitBranches = useGitBranches({
    workspaceId,
    repoId,
    enabled: mode === 'branches',
  });

  const gitHub = useGitHubData({
    repoId,
    enableIssues: mode === 'issues',
    enablePrs: mode === 'prs',
  });

  const handleSelectFile = useCallback(
    (path: string) => {
      setSelectedDiffPath(path);
      openDiffPreview();
      focusDiffPath(path);
    },
    [focusDiffPath, openDiffPreview, setSelectedDiffPath]
  );

  const handleDoubleClickFile = useCallback(
    (path: string) => {
      setSelectedDiffPath(path);
      openDiffPreview();
      focusDiffPath(path);
    },
    [focusDiffPath, openDiffPreview, setSelectedDiffPath]
  );

  const handleRevertAll = useCallback(() => {
    revertAll();
  }, [revertAll]);

  if (!workspaceId && !repoId) return <EmptyState />;
  if (statusLoading && !displayedBranchName) return <LoadingState />;

  return (
    <div
      className="h-full w-full flex flex-col bg-background overflow-hidden"
      data-panel="git"
    >
      {/* Header bar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-1 text-xs text-foreground mr-1">
          <GitBranch className="h-3 w-3 text-muted-foreground" />
          <span className="font-mono font-medium truncate max-w-[120px]">
            {displayedBranchName}
          </span>
        </div>

        {(totalAdditions > 0 || totalDeletions > 0) && (
          <span className="text-[10px] font-mono shrink-0">
            {totalAdditions > 0 && (
              <span className="text-[hsl(var(--success))]">+{totalAdditions}</span>
            )}
            {totalAdditions > 0 && totalDeletions > 0 && (
              <span className="text-muted-foreground">/</span>
            )}
            {totalDeletions > 0 && (
              <span className="text-destructive">-{totalDeletions}</span>
            )}
          </span>
        )}

        <div className="flex-1" />

        {/* Pull/Fetch buttons (visible in diff mode) */}
        {mode === 'diff' && (
          <div className="flex items-center gap-0.5 mr-1">
            <button
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-40"
              onClick={onFetch}
              disabled={fetchLoading}
              title="Fetch all remotes"
            >
              {fetchLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
            </button>
            <button
              className={`p-1 rounded transition-colors relative disabled:opacity-40 ${
                gitLog.behind > 0
                  ? 'text-[hsl(var(--warning))] hover:bg-[hsl(var(--warning)/0.1)] hover:text-[hsl(var(--warning))]'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
              }`}
              onClick={onPull}
              disabled={pullLoading}
              title={
                gitLog.behind > 0
                  ? `Pull ${gitLog.behind} commit${gitLog.behind > 1 ? 's' : ''}`
                  : 'Pull from remote'
              }
            >
              {pullLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              {gitLog.behind > 0 && (
                <span className="absolute -right-1 -top-1 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-[hsl(var(--warning))] px-0.5 text-[8px] font-bold leading-none text-background">
                  {gitLog.behind}
                </span>
              )}
            </button>
          </div>
        )}

        {/* Flat/Tree toggle (only in diff mode) */}
        {mode === 'diff' && (
          <button
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors mr-1"
            onClick={toggleDiffListView}
            title={
              diffListView === 'flat'
                ? 'Switch to tree view (Alt+Shift+V)'
                : 'Switch to flat view (Alt+Shift+V)'
            }
          >
            {diffListView === 'flat' ? (
              <FolderTree className="h-3 w-3" />
            ) : (
              <LayoutList className="h-3 w-3" />
            )}
          </button>
        )}

        {/* Mode tabs */}
        <div className="flex items-center gap-0.5 text-[10px]">
          <button
            className={`px-1.5 py-0.5 rounded transition-colors flex items-center gap-0.5 ${
              mode === 'diff'
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setMode('diff')}
          >
            <ArrowLeftRight className="h-3 w-3" />
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
          <button
            className={`px-1.5 py-0.5 rounded transition-colors flex items-center gap-0.5 ${
              mode === 'branches'
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setMode('branches')}
          >
            <GitBranchPlus className="h-3 w-3" />
            Branches
          </button>
          <span className="text-muted-foreground/30 mx-0.5">|</span>
          <button
            className={`px-1.5 py-0.5 rounded transition-colors flex items-center gap-0.5 ${
              mode === 'issues'
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setMode('issues')}
          >
            <CircleDot className="h-3 w-3" />
            Issues
          </button>
          <button
            className={`px-1.5 py-0.5 rounded transition-colors flex items-center gap-0.5 ${
              mode === 'prs'
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setMode('prs')}
          >
            <GitPullRequest className="h-3 w-3" />
            PRs
          </button>
        </div>
      </div>

      {/* Diff mode */}
      {mode === 'diff' && (
        <div className="flex flex-col flex-1 min-h-0">
          <GitCommitBox
            commitMessage={commitMessage}
            onCommitMessageChange={setCommitMessage}
            hasStagedFiles={stagedFiles.length > 0}
            hasUnstagedFiles={unstagedFiles.length > 0}
            stagedFiles={stagedFiles}
            diffs={diffs}
            commitLoading={commitLoading}
            pushLoading={pushLoading}
            commitError={commitError}
            operationError={operationError}
            commitsAhead={gitLog.ahead}
            onCommit={onCommit}
            onCommitAndPush={onCommitAndPush}
            onPush={onPush}
          />

          <div className="flex flex-1 min-h-0">
            <div className="w-full flex flex-col min-h-0 overflow-y-auto">
              <GitStagingArea
                stagedFiles={stagedFiles}
                unstagedFiles={unstagedFiles}
                selectedPath={selectedDiffPath}
                viewMode={diffListView}
                onSelectFile={handleSelectFile}
                onDoubleClickFile={handleDoubleClickFile}
                onStageFile={stageFile}
                onUnstageFile={unstageFile}
                onRevertFile={revertFile}
                onStageAll={stageAll}
                onRevertAll={handleRevertAll}
              />
            </div>
          </div>
        </div>
      )}

      {/* Log mode */}
      {mode === 'log' && (
        <GitLogView
          entries={gitLog.entries}
          total={gitLog.total}
          ahead={gitLog.ahead}
          behind={gitLog.behind}
          upstream={gitLog.upstream}
          branchName={gitLog.branchName || displayedBranchName}
          loading={gitLog.isLoading}
          workspaceId={workspaceId}
          repoId={repoId}
          onRefresh={gitLog.refresh}
        />
      )}

      {/* Branches mode */}
      {mode === 'branches' && (
        <GitBranchList
          branches={gitBranches.branches}
          isLoading={gitBranches.isLoading}
          error={gitBranches.error}
          onCheckout={gitBranches.checkoutBranch}
          onCreate={gitBranches.createBranch}
          onDelete={gitBranches.deleteBranch}
          onRefresh={gitBranches.refresh}
        />
      )}

      {/* Issues mode */}
      {mode === 'issues' && (
        <GitIssuesView
          issues={gitHub.issues}
          isLoading={gitHub.issuesLoading}
          error={gitHub.issuesError}
          issueState={gitHub.issueFilter}
          onSetIssueState={gitHub.setIssueFilter}
          onRefresh={gitHub.refreshIssues}
        />
      )}

      {/* PRs mode */}
      {mode === 'prs' && (
        <GitPRsView
          prs={gitHub.prs}
          isLoading={gitHub.prsLoading}
          error={gitHub.prsError}
          onRefresh={gitHub.refreshPrs}
        />
      )}
    </div>
  );
}
