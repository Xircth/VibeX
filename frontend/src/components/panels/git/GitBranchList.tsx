import { memo, useState, useCallback, useMemo } from 'react';
import {
  GitBranch as GitBranchIcon,
  Plus,
  Trash2,
  Check,
  Loader2,
  Globe,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Zap,
  Bug,
  Tag,
  GitMerge,
} from 'lucide-react';
import type { GitBranch } from 'shared/types';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';

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

interface BranchGroup {
  key: string;
  label: string;
  items: GitBranch[];
}

function getBranchScope(name: string): string {
  const slashIndex = name.indexOf('/');
  if (slashIndex <= 0) return '__root__';
  return name.slice(0, slashIndex);
}

function getBranchLeafName(name: string): string {
  const slashIndex = name.indexOf('/');
  if (slashIndex <= 0) return name;
  return name.slice(slashIndex + 1);
}

/** Get scope-specific icon for branch groups */
function getScopeIcon(scope: string): React.ReactNode {
  const cls = 'h-3 w-3 shrink-0';
  switch (scope.toLowerCase()) {
    case 'feature':
    case 'feat':
      return <Zap className={`${cls} text-primary`} />;
    case 'fix':
    case 'bugfix':
    case 'hotfix':
      return <Bug className={`${cls} text-[hsl(var(--warning))]`} />;
    case 'release':
      return <Tag className={`${cls} text-[hsl(var(--success))]`} />;
    case 'merge':
      return <GitMerge className={`${cls} text-[hsl(var(--status-running))]`} />;
    default:
      return <FolderOpen className={`${cls} text-muted-foreground/60`} />;
  }
}

const BranchRow = memo(function BranchRow({
  branch,
  showLeafName,
  onCheckout,
  onDelete,
}: {
  branch: GitBranch;
  showLeafName?: boolean;
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

  const handleDelete = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (branch.is_current) return;
      const result = await ConfirmDialog.show({
        title: `Delete branch "${branch.name}"?`,
        message: 'This action cannot be undone.',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        variant: 'destructive',
      });
      if (result !== 'confirmed') {
        return;
      }
      setActionLoading(true);
      try {
        await onDelete(branch.name);
        toast.success(`Deleted branch "${branch.name}"`);
      } catch (error) {
        console.error('Failed to delete branch:', error);
        toast.error(`Failed to delete branch "${branch.name}"`);
      } finally {
        setActionLoading(false);
      }
    },
    [branch.name, branch.is_current, onDelete]
  );

  const displayName = showLeafName
    ? getBranchLeafName(branch.name)
    : branch.name;

  return (
    <div
      className={`flex items-center gap-2 px-2.5 py-1.5 text-xs group cursor-pointer transition-colors ${
        branch.is_current
          ? 'border-l border-l-[hsl(var(--success))] bg-[hsl(var(--success)/0.08)] text-foreground'
          : 'border-l border-l-transparent text-foreground/80 hover:bg-accent/20'
      }`}
      onClick={handleCheckout}
      title={
        branch.is_current
          ? 'Current branch'
          : branch.is_remote
            ? 'Remote branch'
            : `Switch to ${branch.name}`
      }
    >
      {actionLoading ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : branch.is_current ? (
        <div className="shrink-0 w-4 h-4 rounded-full bg-[hsl(var(--success)/0.18)] flex items-center justify-center">
          <Check className="h-3 w-3 text-[hsl(var(--success))]" />
        </div>
      ) : branch.is_remote ? (
        <Globe className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--status-running)/0.64)]" />
      ) : (
        <GitBranchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}

      <span
        className={`flex-1 truncate font-mono text-[11px] ${branch.is_current ? 'font-semibold' : ''}`}
      >
        {displayName}
      </span>

      <span className="text-[10px] text-muted-foreground shrink-0">
        {formatRelativeTime(new Date(branch.last_commit_date))}
      </span>

      {!branch.is_current && !branch.is_remote && (
        <button
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/20 hover:text-destructive transition-colors"
          onClick={handleDelete}
          title={`Delete ${branch.name}`}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
});

const BranchGroupSection = memo(function BranchGroupSection({
  group,
  defaultOpen,
  onCheckout,
  onDelete,
}: {
  group: BranchGroup;
  defaultOpen?: boolean;
  onCheckout: (name: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen ?? true);
  const isRoot = group.key === '__root__';

  return (
    <div>
      <button
        className="w-full flex items-center gap-1.5 px-2.5 py-1 text-[10px] text-muted-foreground font-medium uppercase tracking-wider bg-background/50 hover:bg-accent/10 transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        {isOpen ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {!isRoot && getScopeIcon(group.key)}
        <span>{group.label}</span>
        <span className="ml-1 px-1.5 py-0 rounded-full bg-foreground/10 text-muted-foreground/60 font-mono text-[9px]">
          {group.items.length}
        </span>
      </button>
      {isOpen &&
        group.items.map((branch) => (
          <BranchRow
            key={branch.name}
            branch={branch}
            showLeafName={!isRoot}
            onCheckout={onCheckout}
            onDelete={onDelete}
          />
        ))}
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

  const localBranches = useMemo(
    () => branches.filter((b) => !b.is_remote),
    [branches]
  );
  const remoteBranches = useMemo(
    () => branches.filter((b) => b.is_remote),
    [branches]
  );

  // Group local branches by scope (prefix before first /)
  const groupedLocalBranches = useMemo<BranchGroup[]>(() => {
    const groups = new Map<string, GitBranch[]>();

    for (const branch of localBranches) {
      const scope = getBranchScope(branch.name);
      const items = groups.get(scope) ?? [];
      items.push(branch);
      groups.set(scope, items);
    }

    return Array.from(groups.entries())
      .sort(([left], [right]) => {
        if (left === '__root__') return -1;
        if (right === '__root__') return 1;
        return left.localeCompare(right);
      })
      .map(([key, items]) => ({
        key,
        label: key === '__root__' ? 'Main' : key.toUpperCase(),
        items: items.slice().sort((a, b) => {
          // current branch first
          if (a.is_current) return -1;
          if (b.is_current) return 1;
          return a.name.localeCompare(b.name);
        }),
      }));
  }, [localBranches]);

  // Group remote branches by remote name (origin, upstream, etc.)
  const groupedRemoteBranches = useMemo<BranchGroup[]>(() => {
    const groups = new Map<string, GitBranch[]>();

    for (const branch of remoteBranches) {
      const slashIdx = branch.name.indexOf('/');
      const remoteName =
        slashIdx > 0 ? branch.name.slice(0, slashIdx) : 'unknown';
      const items = groups.get(remoteName) ?? [];
      items.push(branch);
      groups.set(remoteName, items);
    }

    return Array.from(groups.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, items]) => ({
        key,
        label: key.toUpperCase(),
        items: items.slice().sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }, [remoteBranches]);

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
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border/30 text-xs">
        <GitBranchIcon className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="font-medium text-foreground">Branches</span>
        <span className="px-1.5 py-0 rounded-full bg-foreground/10 text-muted-foreground text-[10px] font-mono">
          {localBranches.length}
        </span>
        {remoteBranches.length > 0 && (
          <span className="rounded-full bg-[hsl(var(--status-running)/0.1)] px-1.5 py-0 text-[10px] font-mono text-[hsl(var(--status-running))]">
            {remoteBranches.length} remote
          </span>
        )}
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
            {createLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              'Create'
            )}
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
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading branches...
          </div>
        )}

        {/* Local branches - grouped */}
        {groupedLocalBranches.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-muted-foreground font-semibold uppercase tracking-wider bg-muted/30 border-b border-border/20">
              <GitBranchIcon className="h-3 w-3" />
              <span>Local</span>
            </div>
            {groupedLocalBranches.length === 1 &&
            groupedLocalBranches[0].key === '__root__'
              ? // Only root group - render flat (no sub-grouping needed)
                groupedLocalBranches[0].items.map((branch) => (
                  <BranchRow
                    key={branch.name}
                    branch={branch}
                    onCheckout={onCheckout}
                    onDelete={onDelete}
                  />
                ))
              : // Multiple groups - render with grouping
                groupedLocalBranches.map((group) => (
                  <BranchGroupSection
                    key={group.key}
                    group={group}
                    defaultOpen={group.key === '__root__'}
                    onCheckout={onCheckout}
                    onDelete={onDelete}
                  />
                ))}
          </div>
        )}

        {/* Remote branches - grouped by remote */}
        {groupedRemoteBranches.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-muted-foreground font-semibold uppercase tracking-wider bg-muted/30 border-b border-border/20">
              <Globe className="h-3 w-3 text-[hsl(var(--status-running)/0.64)]" />
              <span>Remote</span>
            </div>
            {groupedRemoteBranches.length === 1
              ? // Single remote - render flat
                groupedRemoteBranches[0].items.map((branch) => (
                  <BranchRow
                    key={branch.name}
                    branch={branch}
                    showLeafName
                    onCheckout={onCheckout}
                    onDelete={onDelete}
                  />
                ))
              : // Multiple remotes - render with grouping
                groupedRemoteBranches.map((group) => (
                  <BranchGroupSection
                    key={group.key}
                    group={group}
                    defaultOpen={false}
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
