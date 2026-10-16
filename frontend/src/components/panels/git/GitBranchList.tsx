import { memo, useState, useCallback, useMemo } from 'react';
import {
  GitBranch as GitBranchIcon,
  Plus,
  Trash2,
  Check,
  Loader2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { GitBranch, GitRemote } from 'shared/types';
import { toast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';

interface GitBranchListProps {
  branches: GitBranch[];
  remotes?: GitRemote[];
  isLoading: boolean;
  error: string | null;
  onCheckout?: (name: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onRefresh: () => void;
}

export type RemoteProviderType = 'github' | 'gitee' | 'default';

export function resolveRemoteProvider(
  remotes?: GitRemote[]
): RemoteProviderType {
  if (!remotes || remotes.length === 0) return 'default';
  const primaryRemote = remotes.find((r) => r.name === 'origin') ?? remotes[0];
  const url = (primaryRemote?.url ?? '').toLowerCase();
  if (url.includes('github.com')) return 'github';
  if (url.includes('gitee.com')) return 'gitee';
  return 'default';
}

function GitHubProviderIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
      data-testid="remote-provider-icon-github"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function GiteeProviderIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
      data-testid="remote-provider-icon-gitee"
    >
      <path d="M11.984 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.016 0zm6.09 5.333c.328 0 .593.266.592.593v1.482a.594.594 0 0 1-.593.592H9.777c-.982 0-1.778.796-1.778 1.778v5.63c0 .327.266.592.593.592h5.63c.982 0 1.778-.796 1.778-1.778v-.296a.593.593 0 0 0-.592-.593h-4.15a.592.592 0 0 1-.592-.592v-1.482a.593.593 0 0 1 .593-.592h6.815c.327 0 .593.265.593.592v3.408a4 4 0 0 1-4 4H5.926a.593.593 0 0 1-.593-.593V9.778a4.444 4.444 0 0 1 4.445-4.444h8.296z" />
    </svg>
  );
}

function renderRemoteProviderIcon(provider: RemoteProviderType) {
  if (provider === 'github') {
    return <GitHubProviderIcon className="h-3 w-3 shrink-0" />;
  }
  if (provider === 'gitee') {
    return <GiteeProviderIcon className="h-3 w-3 shrink-0" />;
  }
  return (
    <GitBranchIcon
      className="h-3 w-3 shrink-0"
      data-testid="remote-provider-icon-default"
    />
  );
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

const BranchRow = memo(function BranchRow({
  branch,
  showLeafName,
  onDelete,
}: {
  branch: GitBranch;
  showLeafName?: boolean;
  onDelete: (name: string) => Promise<void>;
}) {
  const [actionLoading, setActionLoading] = useState(false);

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
      data-testid={`git-branch-row-${branch.name}`}
      className={`my-0.5 flex items-center gap-2 rounded-md px-2 py-1 text-xs group transition-colors ${
        branch.is_current
          ? 'bg-[hsl(var(--success)/0.12)] text-foreground'
          : 'bg-muted/20 text-foreground/80 hover:bg-accent/40'
      }`}
    >
      {actionLoading ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : branch.is_current ? (
        <div className="shrink-0 w-4 h-4 rounded-full bg-[hsl(var(--success)/0.18)] flex items-center justify-center">
          <Check className="h-3 w-3 text-[hsl(var(--success))]" />
        </div>
      ) : (
        <GitBranchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}

      <span className="flex-1 truncate font-mono text-[11px] font-bold text-foreground">
        {displayName}
      </span>

      <span className="text-[10px] text-muted-foreground shrink-0">
        {formatRelativeTime(new Date(branch.last_commit_date))}
      </span>

      {!branch.is_current && !branch.is_remote && (
        <button
          type="button"
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
  onDelete,
}: {
  group: BranchGroup;
  defaultOpen?: boolean;
  onDelete: (name: string) => Promise<void>;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen ?? true);
  const isRoot = group.key === '__root__';

  return (
    <div className="flex flex-col">
      <button
        type="button"
        data-testid={`git-branch-group-${group.key}`}
        className="my-0.5 flex w-full items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent/40"
        onClick={() => setIsOpen(!isOpen)}
      >
        {isOpen ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span>{group.label}</span>
        <span className="ml-auto rounded-full bg-foreground/10 px-1.5 py-0 font-mono text-[9px] text-muted-foreground/70">
          {group.items.length}
        </span>
      </button>
      {isOpen && (
        <div
          data-testid={`git-branch-group-items-${group.key}`}
          className="ml-2.5 pl-2 border-l border-border/40 flex flex-col gap-0.5"
        >
          {group.items.map((branch) => (
            <BranchRow
              key={branch.name}
              branch={branch}
              showLeafName={!isRoot}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
});

export const GitBranchList = memo(function GitBranchList({
  branches,
  remotes,
  isLoading,
  error,
  onCreate,
  onDelete,
}: GitBranchListProps) {
  const [showCreateInput, setShowCreateInput] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const [remoteCollapsed, setRemoteCollapsed] = useState(false);

  const localBranches = useMemo(
    () => branches.filter((b) => !b.is_remote),
    [branches]
  );
  const remoteBranches = useMemo(
    () => branches.filter((b) => b.is_remote),
    [branches]
  );

  const remoteProvider = useMemo(
    () => resolveRemoteProvider(remotes),
    [remotes]
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
      {/* Error */}
      {error && (
        <div className="px-2 py-1 text-[10px] text-destructive border-b border-border/30">
          {error}
        </div>
      )}

      {/* Branch list */}
      <div className="flex-1 overflow-y-auto px-1.5 py-1 flex flex-col gap-1.5">
        {isLoading && branches.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading branches...
          </div>
        )}

        {/* Local branches - grouped */}
        {(!isLoading || branches.length > 0) && (
          <div className="flex flex-col gap-0.5">
            <div
              role="button"
              tabIndex={0}
              aria-expanded={!localCollapsed}
              data-testid="git-branch-section-header-local"
              className="my-0.5 flex cursor-pointer select-none items-center justify-between rounded-md bg-muted/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-muted/80"
              onClick={() => setLocalCollapsed((prev) => !prev)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setLocalCollapsed((prev) => !prev);
                }
              }}
            >
              <div className="flex items-center gap-1.5">
                <GitBranchIcon
                  className="h-3 w-3 shrink-0"
                  data-testid="local-section-icon"
                />
                <span>Local</span>
              </div>
              <div
                className="flex items-center gap-1.5"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="p-0.5 rounded hover:bg-background text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => {
                    const next = !showCreateInput;
                    setShowCreateInput(next);
                    if (next) setLocalCollapsed(false);
                  }}
                  title="Create new branch"
                >
                  <Plus className="h-3 w-3" />
                </button>
                <span
                  data-testid="git-branch-local-count"
                  className="font-mono text-[10px] text-muted-foreground/80"
                >
                  {localBranches.length}
                </span>
              </div>
            </div>

            {!localCollapsed && (
              <div
                data-testid="git-branch-section-body-local"
                className="ml-2.5 pl-2 border-l border-border/50 flex flex-col gap-0.5"
              >
                {/* Create branch input */}
                {showCreateInput && (
                  <div className="my-0.5 flex items-center gap-1 rounded-md bg-muted/30 px-2 py-1.5">
                    <input
                      className="flex-1 bg-background/50 border border-border/50 rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
                      placeholder="New branch name..."
                      value={newBranchName}
                      onChange={(e) => setNewBranchName(e.target.value)}
                      onKeyDown={handleKeyDown}
                      autoFocus
                    />
                    <button
                      type="button"
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

                {groupedLocalBranches.length === 1 &&
                groupedLocalBranches[0].key === '__root__'
                  ? // Only root group - render flat (no sub-grouping needed)
                    groupedLocalBranches[0].items.map((branch) => (
                      <BranchRow
                        key={branch.name}
                        branch={branch}
                        onDelete={onDelete}
                      />
                    ))
                  : // Multiple groups - render with grouping
                    groupedLocalBranches.map((group) => (
                      <BranchGroupSection
                        key={group.key}
                        group={group}
                        defaultOpen={group.key === '__root__'}
                        onDelete={onDelete}
                      />
                    ))}
              </div>
            )}
          </div>
        )}

        {/* Remote branches - grouped by remote */}
        {groupedRemoteBranches.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div
              role="button"
              tabIndex={0}
              aria-expanded={!remoteCollapsed}
              data-testid="git-branch-section-header-remote"
              className="my-0.5 flex cursor-pointer select-none items-center justify-between rounded-md bg-muted/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-muted/80"
              onClick={() => setRemoteCollapsed((prev) => !prev)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setRemoteCollapsed((prev) => !prev);
                }
              }}
            >
              <div className="flex items-center gap-1.5">
                {renderRemoteProviderIcon(remoteProvider)}
                <span>Remote</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  data-testid="git-branch-remote-count"
                  className="font-mono text-[10px] text-muted-foreground/80"
                >
                  {remoteBranches.length}
                </span>
              </div>
            </div>
            {!remoteCollapsed && (
              <div
                data-testid="git-branch-section-body-remote"
                className="ml-2.5 pl-2 border-l border-border/50 flex flex-col gap-0.5"
              >
                {groupedRemoteBranches.length === 1
                  ? // Single remote - render flat
                    groupedRemoteBranches[0].items.map((branch) => (
                      <BranchRow
                        key={branch.name}
                        branch={branch}
                        showLeafName
                        onDelete={onDelete}
                      />
                    ))
                  : // Multiple remotes - render with grouping
                    groupedRemoteBranches.map((group) => (
                      <BranchGroupSection
                        key={group.key}
                        group={group}
                        defaultOpen={false}
                        onDelete={onDelete}
                      />
                    ))}
              </div>
            )}
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
