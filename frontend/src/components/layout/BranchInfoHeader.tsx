import { useState, useCallback } from 'react';
import { GitBranch, ArrowUp, ArrowDown, AlertTriangle, ChevronDown } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useWorkspaceBranchStatus } from '@/hooks/useWorkspaceBranchStatus';
import { attemptsApi } from '@/lib/api';
import { ConflictBanner } from '@/components/tasks/ConflictBanner';
import type { ConflictOp, RepoBranchStatus } from 'shared/types';
import { useRepoBranches } from '@/hooks/useRepoBranches';
import { useChangeTargetBranch } from '@/hooks/useChangeTargetBranch';
import { ChangeTargetBranchDialog } from '@/components/dialogs/tasks/ChangeTargetBranchDialog';

export function BranchInfoHeader() {
  const { activeWorktreeId } = useWorktree();
  const { data: branchStatus } = useWorkspaceBranchStatus(activeWorktreeId ?? undefined);

  if (!activeWorktreeId || !branchStatus?.length) return null;

  const repo = branchStatus[0];

  return (
    <div className="shrink-0 border-b border-border bg-muted/30 px-3 py-1.5">
      <div className="flex items-center gap-2 text-xs min-w-0">
        <span className="text-muted-foreground shrink-0">目标</span>
        <TargetBranchDropdown repo={repo} worktreeId={activeWorktreeId} />
        <span className="text-muted-foreground shrink-0">&rarr;</span>
        <span className="font-mono text-foreground truncate">HEAD</span>
        {(repo.commits_ahead ?? 0) > 0 && (
          <span className="flex items-center gap-0.5 text-green-600 shrink-0">
            <ArrowUp className="h-2.5 w-2.5" />
            {repo.commits_ahead}
          </span>
        )}
        {(repo.commits_behind ?? 0) > 0 && (
          <span className="flex items-center gap-0.5 text-orange-500 shrink-0">
            <ArrowDown className="h-2.5 w-2.5" />
            {repo.commits_behind}
          </span>
        )}
        {repo.is_rebase_in_progress && (
          <span className="flex items-center gap-0.5 text-destructive shrink-0">
            <AlertTriangle className="h-2.5 w-2.5" />
            冲突
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <RebaseButton worktreeId={activeWorktreeId} repoId={repo.repo_id} />
          <RebaseBackButton worktreeId={activeWorktreeId} repoId={repo.repo_id} />
        </div>
      </div>
    </div>
  );
}

function TargetBranchDropdown({ repo, worktreeId }: { repo: RepoBranchStatus; worktreeId: string }) {
  const { data: branches = [] } = useRepoBranches(repo.repo_id);
  const changeTargetBranch = useChangeTargetBranch(worktreeId, repo.repo_id);
  const isChangingTargetBranch = changeTargetBranch.isPending;

  const handleChangeTarget = useCallback(async () => {
    try {
      const result = await ChangeTargetBranchDialog.show({
        branches,
        isChangingTargetBranch,
      });
      if (result.action === 'confirmed' && result.branchName) {
        changeTargetBranch.mutate({
          newTargetBranch: result.branchName,
          repoId: repo.repo_id,
        });
      }
    } catch {
      // Dialog was dismissed
    }
  }, [branches, isChangingTargetBranch, changeTargetBranch, repo.repo_id]);

  const handleRebase = useCallback(async () => {
    await attemptsApi.rebase(worktreeId, { repo_id: repo.repo_id, old_base_branch: null, new_base_branch: null });
  }, [worktreeId, repo.repo_id]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1 font-mono text-foreground hover:text-primary transition-colors">
          <GitBranch className="h-3 w-3" />
          <span className="truncate max-w-24">{repo.target_branch_name}</span>
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={handleChangeTarget} disabled={isChangingTargetBranch}>
          {isChangingTargetBranch ? '切换中...' : '切换目标分支'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleRebase}>
          Rebase
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RebaseButton({ worktreeId, repoId }: { worktreeId: string; repoId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const handleRebase = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await attemptsApi.rebase(worktreeId, { repo_id: repoId, old_base_branch: null, new_base_branch: null });
      if (result.error) {
        if (result.error.type === 'rebase_in_progress') {
          setError('Rebase is already in progress.');
        } else {
          setError('Rebase failed with conflicts.');
        }
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['branchStatus'] });
    } catch {
      setError('Rebase failed.');
    } finally {
      setLoading(false);
    }
  }, [worktreeId, repoId, queryClient]);

  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant="outline" size="sm" className="h-5 text-[10px] px-1.5" onClick={handleRebase} disabled={loading}>
        Rebase
      </Button>
      {error && <span className="text-[9px] text-destructive">{error}</span>}
    </div>
  );
}

function RebaseBackButton({ worktreeId, repoId }: { worktreeId: string; repoId: string }) {
  const [loading, setLoading] = useState(false);
  const [conflict, setConflict] = useState<{
    files: string[];
    op: ConflictOp | null;
    targetBranch: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const handleRebaseBack = useCallback(async () => {
    setLoading(true);
    setError(null);
    setConflict(null);
    try {
      const result = await attemptsApi.rebaseBack(worktreeId, repoId);
      if (result.error) {
        const err = result.error;
        if (err.type === 'merge_conflicts') {
          setConflict({
            files: [...err.conflicted_files],
            op: err.op ?? null,
            targetBranch: err.target_branch,
          });
        } else if (err.type === 'rebase_in_progress') {
          setError('Rebase is already in progress.');
        } else {
          setError('Rebase failed.');
        }
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['branchStatus'] });
    } catch {
      setError('Rebase back failed.');
    } finally {
      setLoading(false);
    }
  }, [worktreeId, repoId, queryClient]);

  const handleSendToAI = useCallback(() => {
    // TODO: integrate with AI chat to send conflict info
    setConflict(null);
  }, []);

  const handleAbort = useCallback(async () => {
    // Abort the rebase operation
    setConflict(null);
    queryClient.invalidateQueries({ queryKey: ['branchStatus'] });
  }, [queryClient]);

  const handleOpenEditor = useCallback(() => {
    // Placeholder for open-in-editor functionality
  }, []);

  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant="outline" size="sm" className="h-5 text-[10px] px-1.5" onClick={handleRebaseBack} disabled={loading}>
        Rebase Back
      </Button>
      {error && <span className="text-[9px] text-destructive">{error}</span>}
      {conflict && (
        <ConflictBanner
          attemptBranch={null}
          baseBranch={conflict.targetBranch}
          conflictedFiles={conflict.files}
          op={conflict.op}
          onOpenEditor={handleOpenEditor}
          onAbort={handleAbort}
          onResolve={handleSendToAI}
          resolveLabel="发送给AI"
          enableResolve={true}
          enableAbort={true}
        />
      )}
    </div>
  );
}
