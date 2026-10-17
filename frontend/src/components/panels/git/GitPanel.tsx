import { useCallback, useEffect, useState } from 'react';
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
  type GitPanelMode,
} from '@/hooks/git';
import {
  Selector,
  SelectorOption,
  type SelectorOptionData,
} from '@astryxdesign/core/Selector';
import { GitConflictSection } from './GitConflictSection';
import { GitStagingArea } from './GitStagingArea';
import { GitCommitBox } from './GitCommitBox';
import { GitChangeStats } from './GitChangeStats';
import { GitLogView } from './GitLogView';
import { GitBranchList } from './GitBranchList';
import { GitIssuesView } from './GitIssuesView';
import { GitPRsView } from './GitPRsView';
import { useBranchStatus } from '@/hooks/useBranchStatus';
import { useAttemptConflicts } from '@/hooks/useAttemptConflicts';
import { usePanelActions } from '@/hooks/usePanelActions';
import { useGitDiffNavigationStore } from '@/stores/useGitDiffNavigationStore';
import { useAppContextMenu } from '@/components/context-menu';
import { attemptsApi, projectsApi } from '@/lib/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const GIT_PANEL_MODE_OPTIONS: SelectorOptionData[] = [
  {
    value: 'diff',
    label: 'Diff',
    icon: <ArrowLeftRight className="h-3 w-3" />,
  },
  {
    value: 'log',
    label: 'Log',
    icon: <History className="h-3 w-3" />,
  },
  {
    value: 'branches',
    label: 'Branch',
    icon: <GitBranchPlus className="h-3 w-3" />,
  },
  {
    value: 'issues',
    label: 'Issue',
    icon: <CircleDot className="h-3 w-3" />,
  },
  {
    value: 'prs',
    label: 'PR',
    icon: <GitPullRequest className="h-3 w-3" />,
  },
];

function EmptyState() {
  return (
    <div className="h-full w-full flex items-center justify-center text-muted-foreground text-sm">
      <div className="text-center space-y-2">
        <GitBranch className="h-8 w-8 opacity-40 mx-auto" />
        <p className="font-medium">Git</p>
        <p className="text-xs">这个文件夹不是 Git 仓库。</p>
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
  const { openSurfaceMenu } = useAppContextMenu();
  const { openDiffPreview, openMergePanel } = usePanelActions();
  const queryClient = useQueryClient();
  const [conflictBusy, setConflictBusy] = useState<'continue' | 'abort' | null>(
    null
  );
  const focusDiffPath = useGitDiffNavigationStore((state) => state.focusPath);
  const { activeWorktreeId } = useWorktree();
  const { workspaceId: routeWorkspaceId, projectId } = useParams<{
    workspaceId?: string;
    projectId?: string;
  }>();
  const effectiveWorkspaceId = activeWorktreeId ?? routeWorkspaceId ?? null;
  const { data: workspace } = useAttempt(effectiveWorkspaceId ?? undefined);
  const { selectedRepoId, isLoading: attemptRepoLoading } = useAttemptRepo(
    effectiveWorkspaceId ?? undefined
  );
  const { data: branchStatus } = useBranchStatus(
    effectiveWorkspaceId ?? undefined
  );

  // When no workspace is active, fall back to the project's first repo
  const projectReposQuery = useProjectRepos(projectId, {
    enabled: !!projectId,
  });
  const projectRepos = projectReposQuery.data ?? [];
  const parentHasNoGitRepo =
    projectReposQuery.isSuccess && projectRepos.length === 0;
  const { data: gitChildren = [], isLoading: gitChildrenLoading } = useQuery({
    queryKey: ['project-git-children', projectId],
    queryFn: () => projectsApi.gitChildren(projectId!),
    enabled: Boolean(projectId) && parentHasNoGitRepo,
    staleTime: 30_000,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === projectId ? previousData : undefined,
  });
  const [gitChildId, setGitChildId] = useState<string | null>(null);
  useEffect(() => {
    setGitChildId(null);
  }, [projectId]);
  const selectedGitChildId = gitChildId ?? gitChildren[0]?.id ?? null;
  const { data: childRepos = [], isLoading: childReposLoading } =
    useProjectRepos(selectedGitChildId, {
      enabled: parentHasNoGitRepo && !!selectedGitChildId,
    });
  const fallbackRepoId = parentHasNoGitRepo
    ? (childRepos[0]?.id ?? null)
    : (selectedRepoId ?? projectRepos[0]?.id ?? null);

  const workspaceId = parentHasNoGitRepo ? null : effectiveWorkspaceId;
  const repoId = fallbackRepoId;
  const isResolvingRepo =
    !repoId &&
    (Boolean(projectId && projectReposQuery.isLoading) ||
      Boolean(effectiveWorkspaceId && attemptRepoLoading) ||
      Boolean(parentHasNoGitRepo && (gitChildrenLoading || childReposLoading)));
  const conflictStatus = branchStatus?.find((repo) => repo.repo_id === repoId);
  const conflictOp = conflictStatus?.conflict_op ?? null;
  const conflictedFiles = conflictStatus?.conflicted_files ?? [];
  const { abortConflicts } = useAttemptConflicts(
    workspaceId ?? undefined,
    repoId ?? undefined
  );
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

  const shouldPreloadDiffs =
    mode === 'diff' &&
    stagedFiles.length > 0 &&
    shouldAutoPreloadDiffs(stagedFiles, unstagedFiles);
  const { diffs } = useGitDiffs({
    workspaceId,
    repoId,
    enabled: shouldPreloadDiffs,
  });

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

  if (!repoId && !isResolvingRepo && gitChildren.length === 0) {
    return <EmptyState />;
  }

  const isInitialDiffLoading =
    (isResolvingRepo || statusLoading) &&
    stagedFiles.length === 0 &&
    unstagedFiles.length === 0;

  return (
    <div
      className="h-full w-full flex flex-col bg-background overflow-hidden"
      data-panel="git"
      onContextMenu={(event) => {
        openSurfaceMenu(event, [
          {
            id: 'fetch',
            label: 'Fetch',
            disabled: fetchLoading,
            onSelect: () => onFetch(),
          },
          {
            id: 'pull',
            label: 'Pull',
            disabled: pullLoading,
            onSelect: () => onPull(),
          },
          {
            id: 'push',
            label: 'Push',
            disabled: pushLoading,
            onSelect: () => onPush(),
          },
          {
            id: 'refresh',
            label: 'Refresh',
            onSelect: () => {
              refreshStatus();
            },
          },
        ]);
      }}
    >
      {/* Row 1: Mode Selector + Fetch, Pull, Tree toggle (always visible) */}
      <div
        data-testid="git-panel-mode-tabs"
        className="flex items-center gap-1.5 px-2 py-1 border-b border-border/30 shrink-0"
      >
        <div className="min-w-0 flex-1">
          <Selector
            label="Git view"
            isLabelHidden
            size="sm"
            width="100%"
            placement="below"
            className="git-mode-selector"
            options={GIT_PANEL_MODE_OPTIONS}
            value={mode}
            onChange={(nextMode) => setMode(nextMode as GitPanelMode)}
            startIcon={
              GIT_PANEL_MODE_OPTIONS.find((opt) => opt.value === mode)?.icon
            }
            renderOption={(option) => (
              <SelectorOption
                icon={option.icon}
                label={
                  <span className="text-[11px] font-normal">
                    {option.label ?? option.value}
                  </span>
                }
              />
            )}
          />
        </div>

        {/* Fetch / Pull / Flat-Tree toggle buttons */}
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
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
            type="button"
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
          <button
            type="button"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
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
        </div>
      </div>

      {/* Row 2: Branch info and change stats (only in Diff mode) */}
      {mode === 'diff' && (
        <div
          data-testid="git-panel-branch-toolbar"
          className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-border/30 shrink-0"
        >
          {parentHasNoGitRepo && gitChildren.length > 0 ? (
            <Select
              value={selectedGitChildId ?? ''}
              onValueChange={setGitChildId}
            >
              <SelectTrigger className="h-7 w-[140px] text-xs">
                <SelectValue placeholder="Git 仓库" />
              </SelectTrigger>
              <SelectContent>
                {gitChildren.map((child) => (
                  <SelectItem key={child.id} value={child.id}>
                    {child.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="flex items-center gap-1.5 text-sm text-foreground min-w-0">
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {displayedBranchName ? (
                <span
                  data-testid="git-diff-branch-title"
                  className="truncate max-w-[180px] text-sm font-bold leading-tight text-foreground"
                >
                  {displayedBranchName}
                </span>
              ) : (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              )}
            </div>
          )}

          {(totalAdditions > 0 || totalDeletions > 0) && (
            <GitChangeStats
              additions={totalAdditions}
              deletions={totalDeletions}
              className="ml-auto shrink-0"
            />
          )}
        </div>
      )}

      {/* Diff mode */}
      {mode === 'diff' && (
        <div className="flex flex-col flex-1 min-h-0">
          {workspaceId && repoId && conflictOp ? (
            <GitConflictSection
              op={conflictOp}
              files={conflictedFiles}
              onOpenFile={(filePath) =>
                openMergePanel({ workspaceId, repoId, filePath })
              }
              onContinue={async () => {
                setConflictBusy('continue');
                try {
                  await attemptsApi.continueConflicts(workspaceId, repoId);
                  await queryClient.invalidateQueries({
                    queryKey: ['branchStatus', workspaceId],
                  });
                  refreshStatus();
                } finally {
                  setConflictBusy(null);
                }
              }}
              onAbort={async () => {
                setConflictBusy('abort');
                try {
                  await abortConflicts();
                  refreshStatus();
                } finally {
                  setConflictBusy(null);
                }
              }}
              continueLoading={conflictBusy === 'continue'}
              abortLoading={conflictBusy === 'abort'}
            />
          ) : null}
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
            commitsAhead={
              gitLog.ahead || conflictStatus?.remote_commits_ahead || 0
            }
            onCommit={onCommit}
            onCommitAndPush={onCommitAndPush}
            onPush={onPush}
          />

          <div className="flex flex-1 min-h-0">
            <div className="w-full flex flex-col min-h-0 overflow-y-auto">
              {isInitialDiffLoading ? (
                <LoadingState />
              ) : (
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
              )}
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
          remotes={gitBranches.remotes}
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
