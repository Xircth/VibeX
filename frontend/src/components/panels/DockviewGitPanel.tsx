import type { IDockviewPanelProps } from 'dockview-react';
import { GitBranch, ArrowUp, ArrowDown, AlertTriangle, FileWarning, Circle } from 'lucide-react';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useWorkspaceBranchStatus } from '@/hooks/useWorkspaceBranchStatus';
import { CommitGraph } from '@/components/git/CommitGraph';

function DockviewGitPanel(_props: IDockviewPanelProps) {
  const { activeWorktreeId } = useWorktree();
  const { data: branchStatus, isLoading } = useWorkspaceBranchStatus(activeWorktreeId ?? undefined);

  if (!activeWorktreeId) {
    return (
      <div className="h-full w-full bg-background flex items-center justify-center text-muted-foreground text-sm" data-panel="git">
        <div className="text-center space-y-2">
          <GitBranch className="h-8 w-8 opacity-40 mx-auto" />
          <p className="font-medium">Git 管理器</p>
          <p className="text-xs">选择一个工作区以查看 Git 状态</p>
        </div>
      </div>
    );
  }

  if (isLoading || !branchStatus) {
    return (
      <div className="h-full w-full bg-background flex items-center justify-center text-muted-foreground text-xs" data-panel="git">
        加载 Git 状态...
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto bg-background p-3 text-sm" data-panel="git">
      {branchStatus.map((repo) => (
        <div key={repo.repo_id} className="space-y-3">
          {branchStatus.length > 1 && (
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {repo.repo_name}
            </div>
          )}
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <Circle className="h-2 w-2 fill-blue-500 text-blue-500" />
              <span className="text-muted-foreground">目标分支</span>
              <span className="font-mono font-medium text-foreground">{repo.target_branch_name}</span>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {(repo.commits_ahead ?? 0) > 0 && (
              <span className="flex items-center gap-1 text-green-600">
                <ArrowUp className="h-3 w-3" />
                {repo.commits_ahead} ahead
              </span>
            )}
            {(repo.commits_behind ?? 0) > 0 && (
              <span className="flex items-center gap-1 text-orange-500">
                <ArrowDown className="h-3 w-3" />
                {repo.commits_behind} behind
              </span>
            )}
            {(repo.commits_ahead ?? 0) === 0 && (repo.commits_behind ?? 0) === 0 && (
              <span className="text-muted-foreground">分支已同步</span>
            )}
          </div>
          {repo.has_uncommitted_changes && (
            <div className="flex items-center gap-2 text-xs text-yellow-600">
              <FileWarning className="h-3 w-3" />
              <span>{repo.uncommitted_count ?? 0} 个未提交更改, {repo.untracked_count ?? 0} 个未跟踪</span>
            </div>
          )}
          {repo.is_rebase_in_progress && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3" />
              <span>Rebase 进行中 — {repo.conflicted_files.length} 个冲突文件</span>
            </div>
          )}
          {repo.conflicted_files.length > 0 && (
            <div className="pl-4 space-y-0.5">
              {repo.conflicted_files.map((f) => (
                <div key={f} className="text-xs font-mono text-destructive truncate">{f}</div>
              ))}
            </div>
          )}
          <CommitGraph workspaceId={activeWorktreeId!} repoId={repo.repo_id} />
        </div>
      ))}
    </div>
  );
}

export default DockviewGitPanel;
