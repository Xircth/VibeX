import { memo, useState, useCallback } from 'react';
import { GitBranch as GitBranchIcon, Plus, Trash2, Check, Loader2, Globe } from 'lucide-react';
import type { GitBranch } from 'shared/types';

interface GitBranchListProps {
  branches: GitBranch[];
  isLoading: boolean;
  error: string | null;
  onCheckout: (name: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onRefresh: () => void;
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 604800)}w ago`;
  return date.toLocaleDateString();
}

const BranchRow = memo(function BranchRow({
  branch,
  onCheckout,
  onDelete,
}: {
  branch: GitBranch;
  onCheckout: (name: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}) {
  const [actionLoading, setActionLoading] = useState(false);

  const handleCheckout = useCallback(async () => {
    if (branch.is_current || branch.is_remote) return;
    setActionLoading(true);
    try {
      await onCheckout(branch.name);
    } finally {
      setActionLoading(false);
    }
  }, [branch.name, branch.is_current, branch.is_remote, onCheckout]);

  const handleDelete = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (branch.is_current) return;
    if (!window.confirm(`Delete branch "${branch.name}"? This cannot be undone.`)) return;
    setActionLoading(true);
    try {
      await onDelete(branch.name);
    } finally {
      setActionLoading(false);
    }
  }, [branch.name, branch.is_current, onDelete]);

  return (
    <div
      className={`flex items-center gap-2 px-2 py-1.5 text-xs group cursor-pointer transition-colors ${
        branch.is_current
          ? 'bg-accent/40 text-foreground'
          : 'hover:bg-accent/20 text-foreground/80'
      }`}
      onClick={handleCheckout}
      title={branch.is_current ? 'Current branch' : branch.is_remote ? 'Remote branch' : `Switch to ${branch.name}`}
    >
      {actionLoading ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : branch.is_current ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-green-400" />
      ) : branch.is_remote ? (
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <GitBranchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}

      <span className="flex-1 truncate font-mono text-[11px]">{branch.name}</span>

      <span className="text-[10px] text-muted-foreground shrink-0">
        {formatRelativeTime(new Date(branch.last_commit_date))}
      </span>

      {!branch.is_current && !branch.is_remote && (
        <button
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/20 hover:text-destructive transition-all"
          onClick={handleDelete}
          title={`Delete ${branch.name}`}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
});

export const GitBranchList = memo(function GitBranchList({
  branches,
  isLoading,
  error,
  onCheckout,
  onCreate,
  onDelete,
}: GitBranchListProps) {
  const [showCreateInput, setShowCreateInput] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [createLoading, setCreateLoading] = useState(false);

  const localBranches = branches.filter((b) => !b.is_remote);
  const remoteBranches = branches.filter((b) => b.is_remote);

  const handleCreate = useCallback(async () => {
    const trimmed = newBranchName.trim();
    if (!trimmed) return;
    setCreateLoading(true);
    try {
      await onCreate(trimmed);
      setNewBranchName('');
      setShowCreateInput(false);
    } catch {
      // error handled by parent hook
    } finally {
      setCreateLoading(false);
    }
  }, [newBranchName, onCreate]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCreate();
      } else if (e.key === 'Escape') {
        setShowCreateInput(false);
        setNewBranchName('');
      }
    },
    [handleCreate]
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border/30 text-xs">
        <span className="font-medium text-foreground">Branches</span>
        <span className="text-muted-foreground text-[10px]">{localBranches.length} local</span>
        <div className="flex-1" />
        <button
          className="p-0.5 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setShowCreateInput(!showCreateInput)}
          title="Create new branch"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Create branch input */}
      {showCreateInput && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/30">
          <input
            className="flex-1 bg-background/50 border border-border/50 rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
            placeholder="New branch name..."
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <button
            className="px-2 py-1 rounded text-[11px] bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            disabled={!newBranchName.trim() || createLoading}
            onClick={handleCreate}
          >
            {createLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Create'}
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-2 py-1 text-[10px] text-destructive border-b border-border/30">
          {error}
        </div>
      )}

      {/* Branch list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && branches.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
            Loading branches...
          </div>
        )}

        {/* Local branches */}
        {localBranches.length > 0 && (
          <div>
            <div className="px-2 py-1 text-[10px] text-muted-foreground font-medium uppercase tracking-wider bg-background/50">
              Local
            </div>
            {localBranches.map((branch) => (
              <BranchRow
                key={branch.name}
                branch={branch}
                onCheckout={onCheckout}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}

        {/* Remote branches */}
        {remoteBranches.length > 0 && (
          <div>
            <div className="px-2 py-1 text-[10px] text-muted-foreground font-medium uppercase tracking-wider bg-background/50">
              Remote
            </div>
            {remoteBranches.map((branch) => (
              <BranchRow
                key={branch.name}
                branch={branch}
                onCheckout={onCheckout}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}

        {!isLoading && branches.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
            No branches found
          </div>
        )}
      </div>
    </div>
  );
});
