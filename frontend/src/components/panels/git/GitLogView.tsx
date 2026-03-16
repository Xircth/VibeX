import { memo, useMemo, useCallback, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import {
  GitCommit,
  ArrowUp,
  ArrowDown,
  Upload,
  Download,
  Copy,
  ClipboardCopy,
  GitBranch,
  RotateCcw,
  Undo2,
  CherryIcon,
  Loader2,
  Search,
} from 'lucide-react';
import type { GitLogEntry } from 'shared/types';
import { attemptsApi, repoApi } from '@/lib/api';
import { GitContextMenu, type ContextMenuAction } from './GitContextMenu';
import { useCommitDiffStore } from '@/stores/useCommitDiffStore';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';

interface GitLogViewProps {
  entries: GitLogEntry[];
  total: number;
  ahead: number;
  behind: number;
  upstream: string | null;
  branchName: string;
  loading?: boolean;
  workspaceId: string | null;
  repoId: string | null;
  onRefresh?: () => Promise<void>;
}

function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}w ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

/** Generate a stable color for a string (author name) */
function stringToColor(str: string): string {
  const colors = [
    'bg-blue-500', 'bg-green-500', 'bg-purple-500', 'bg-orange-500',
    'bg-pink-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-teal-500',
  ];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

/** Color for ref badge based on ref type */
function getRefBadgeStyle(ref: string): string {
  if (ref.startsWith('origin/') || ref.startsWith('upstream/')) {
    return 'bg-purple-500/15 text-purple-400 border-purple-500/30';
  }
  if (ref.startsWith('tag:') || ref.startsWith('v')) {
    return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
  }
  return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
}

interface ContextMenuState {
  x: number;
  y: number;
  entry: GitLogEntry;
}

const LogEntry = memo(function LogEntry({
  entry,
  isSelected,
  isHead,
  isPushable,
  onSelect,
  onContextMenu,
}: {
  entry: GitLogEntry;
  isSelected: boolean;
  isHead: boolean;
  isPushable: boolean;
  onSelect: (sha: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: GitLogEntry) => void;
}) {
  const handleCopyClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(entry.sha);
    },
    [entry.sha]
  );

  const initial = entry.author.charAt(0).toUpperCase();
  const avatarColor = stringToColor(entry.author);

  return (
    <div
      className={`flex items-start gap-2.5 px-2.5 py-2 text-xs group cursor-pointer transition-colors border-l-2 ${
        isSelected
          ? 'bg-accent/50 border-l-blue-500'
          : isHead
            ? 'bg-accent/20 border-l-green-500'
            : isPushable
              ? 'hover:bg-accent/30 border-l-green-500/40'
              : 'hover:bg-accent/30 border-l-transparent'
      }`}
      onClick={() => onSelect(entry.sha)}
      onContextMenu={(e) => onContextMenu(e, entry)}
    >
      {/* Author avatar */}
      <div
        className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${avatarColor}`}
        title={entry.author}
      >
        {initial}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        {/* Summary */}
        <span className="text-foreground leading-tight break-all">{entry.summary}</span>

        {/* Refs badges */}
        {entry.refs.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-0.5">
            {entry.refs.map((ref) => (
              <span
                key={ref}
                className={`inline-flex items-center gap-0.5 px-1.5 py-0 rounded text-[9px] font-medium border ${getRefBadgeStyle(ref)}`}
              >
                {ref.startsWith('origin/') || ref.startsWith('upstream/') ? (
                  <span className="opacity-60">{'~'}</span>
                ) : (
                  <GitBranch className="h-2.5 w-2.5 opacity-60" />
                )}
                {ref}
              </span>
            ))}
          </div>
        )}

        {/* Meta row */}
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
          <button
            className="font-mono hover:text-foreground transition-colors flex items-center gap-0.5"
            onClick={handleCopyClick}
            title="Copy full SHA"
          >
            {entry.sha.slice(0, 7)}
            <Copy className="h-2.5 w-2.5 opacity-0 group-hover:opacity-60" />
          </button>
          <span className="truncate">{entry.author}</span>
          <span className="shrink-0">{formatRelativeTime(entry.timestamp)}</span>
        </div>
      </div>
    </div>
  );
});

/** Discriminated union for flat virtual list items */
type VirtualListItem =
  | { type: 'section-header'; title: string; icon: 'upload' | 'download' | 'commit'; count: number; accentColor: string; extra?: string }
  | { type: 'entry'; entry: GitLogEntry; isPushable: boolean };

export const GitLogView = memo(function GitLogView(props: GitLogViewProps) {
  const {
    entries,
    ahead,
    behind,
    upstream,
    branchName,
    loading,
    workspaceId,
    repoId,
    onRefresh,
  } = props;
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [createBranchInput, setCreateBranchInput] = useState<{ sha: string; show: boolean }>({
    sha: '',
    show: false,
  });
  const [newBranchName, setNewBranchName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  const panelActions = useOptionalPanelActionsContext();
  const { setCommitDiff, setLoading: setCommitDiffLoading } = useCommitDiffStore();

  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => b.timestamp - a.timestamp),
    [entries]
  );

  // Head SHA is the first entry (most recent commit on current branch)
  const headSha = sortedEntries.length > 0 ? sortedEntries[0].sha : null;

  const { aheadEntries, recentEntries } = useMemo(() => {
    if (ahead <= 0) {
      return { aheadEntries: [], recentEntries: sortedEntries };
    }
    return {
      aheadEntries: sortedEntries.slice(0, ahead),
      recentEntries: sortedEntries.slice(ahead),
    };
  }, [sortedEntries, ahead]);

  // Filter entries by search query
  const filteredAhead = useMemo(() => {
    if (!searchQuery) return aheadEntries;
    const q = searchQuery.toLowerCase();
    return aheadEntries.filter(
      (e) =>
        e.summary.toLowerCase().includes(q) ||
        e.author.toLowerCase().includes(q) ||
        e.sha.startsWith(q)
    );
  }, [aheadEntries, searchQuery]);

  const filteredRecent = useMemo(() => {
    if (!searchQuery) return recentEntries;
    const q = searchQuery.toLowerCase();
    return recentEntries.filter(
      (e) =>
        e.summary.toLowerCase().includes(q) ||
        e.author.toLowerCase().includes(q) ||
        e.sha.startsWith(q)
    );
  }, [recentEntries, searchQuery]);

  const handleSelect = useCallback(
    async (sha: string) => {
      // Toggle deselect
      if (selectedSha === sha) {
        setSelectedSha(null);
        return;
      }
      setSelectedSha(sha);
      if (!repoId) return;

      // Load commit detail + diffs and open in center panel
      setCommitDiffLoading(true);
      panelActions?.openCommitDiff();
      try {
        const [detail, diffs] = await Promise.all([
          workspaceId
            ? attemptsApi.getCommitDetail(workspaceId, repoId, sha)
            : repoApi.getCommitDetail(repoId, sha),
          workspaceId
            ? attemptsApi.getCommitDiffs(workspaceId, repoId, sha)
            : repoApi.getCommitDiffs(repoId, sha),
        ]);
        setCommitDiff(sha, detail, diffs);
      } catch {
        setCommitDiffLoading(false);
      }
    },
    [selectedSha, workspaceId, repoId, setCommitDiff, setCommitDiffLoading, panelActions]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: GitLogEntry) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, entry });
    },
    []
  );

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
    setCreateBranchInput({ sha: '', show: false });
    setNewBranchName('');
  }, []);

  const executeAction = useCallback(
    async (action: () => Promise<void>) => {
      setActionLoading(true);
      try {
        await action();
        await onRefresh?.();
      } catch {
        // errors handled by toast / parent
      } finally {
        setActionLoading(false);
      }
    },
    [onRefresh]
  );

  const buildCommitContextActions = useCallback(
    (entry: GitLogEntry): ContextMenuAction[] => {
      const canOperate = !!workspaceId && !!repoId && !actionLoading;
      const actions: ContextMenuAction[] = [];

      actions.push({
        label: 'Copy SHA',
        icon: <ClipboardCopy className="h-3 w-3" />,
        group: 'quick',
        onClick: () => navigator.clipboard.writeText(entry.sha),
      });
      actions.push({
        label: 'Copy Message',
        icon: <Copy className="h-3 w-3" />,
        group: 'quick',
        onClick: () => navigator.clipboard.writeText(entry.summary),
      });

      actions.push({
        label: 'Create Branch Here',
        icon: <GitBranch className="h-3 w-3" />,
        group: 'branch',
        disabled: !canOperate,
        onClick: () => {
          setContextMenu(null);
          setCreateBranchInput({ sha: entry.sha, show: true });
        },
      });
      actions.push({
        label: 'Reset to This Commit',
        icon: <RotateCcw className="h-3 w-3" />,
        group: 'branch',
        disabled: !canOperate,
        submenu: [
          {
            label: 'Soft (keep changes staged)',
            icon: <RotateCcw className="h-3 w-3" />,
            onClick: () =>
              executeAction(() =>
                attemptsApi.resetToCommit(workspaceId!, repoId!, entry.sha, 'soft')
              ),
          },
          {
            label: 'Mixed (keep changes unstaged)',
            icon: <RotateCcw className="h-3 w-3" />,
            onClick: () =>
              executeAction(() =>
                attemptsApi.resetToCommit(workspaceId!, repoId!, entry.sha, 'mixed')
              ),
          },
          {
            label: 'Hard (discard all changes)',
            icon: <RotateCcw className="h-3 w-3" />,
            danger: true,
            onClick: () => {
              if (window.confirm('This will discard all uncommitted changes. Continue?')) {
                executeAction(() =>
                  attemptsApi.resetToCommit(workspaceId!, repoId!, entry.sha, 'hard')
                );
              }
            },
          },
        ],
        onClick: () => {},
      });

      actions.push({
        label: 'Cherry-pick',
        icon: <CherryIcon className="h-3 w-3" />,
        group: 'write',
        disabled: !canOperate,
        onClick: () =>
          executeAction(() => attemptsApi.cherryPick(workspaceId!, repoId!, entry.sha)),
      });
      actions.push({
        label: 'Revert',
        icon: <Undo2 className="h-3 w-3" />,
        group: 'write',
        disabled: !canOperate,
        onClick: () =>
          executeAction(() => attemptsApi.revertCommit(workspaceId!, repoId!, entry.sha)),
      });

      return actions;
    },
    [workspaceId, repoId, actionLoading, executeAction]
  );

  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name || !workspaceId || !repoId) return;
    await executeAction(() =>
      attemptsApi.createBranchAtCommit(workspaceId, repoId, name, createBranchInput.sha)
    );
    setCreateBranchInput({ sha: '', show: false });
    setNewBranchName('');
  }, [newBranchName, workspaceId, repoId, createBranchInput.sha, executeAction]);

  // Build flat virtual list items from sections
  const virtualItems = useMemo<VirtualListItem[]>(() => {
    const items: VirtualListItem[] = [];

    // "To Push" section
    if (ahead > 0 && filteredAhead.length > 0) {
      items.push({
        type: 'section-header',
        title: 'To Push',
        icon: 'upload',
        count: ahead,
        accentColor: 'text-green-400',
      });
      for (const entry of filteredAhead) {
        items.push({ type: 'entry', entry, isPushable: true });
      }
    }

    // "To Pull" indicator
    if (behind > 0) {
      items.push({
        type: 'section-header',
        title: 'To Pull',
        icon: 'download',
        count: behind,
        accentColor: 'text-yellow-400',
        extra: 'Fetch or pull to see these commits',
      });
    }

    // "Recent Commits" section
    if (filteredRecent.length > 0) {
      if (ahead > 0 || behind > 0) {
        items.push({
          type: 'section-header',
          title: 'Recent Commits',
          icon: 'commit',
          count: 0,
          accentColor: 'text-muted-foreground',
        });
      }
      for (const entry of filteredRecent) {
        items.push({ type: 'entry', entry, isPushable: false });
      }
    }

    return items;
  }, [ahead, behind, filteredAhead, filteredRecent]);

  const sectionIcons = useMemo(() => ({
    upload: <Upload className="h-3 w-3" />,
    download: <Download className="h-3 w-3" />,
    commit: <GitCommit className="h-3 w-3" />,
  }), []);

  const renderVirtualItem = useCallback(
    (_index: number, item: VirtualListItem) => {
      if (item.type === 'section-header') {
        return (
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider bg-muted/30 border-b border-border/20 ${item.accentColor}`}
          >
            {sectionIcons[item.icon]}
            <span>{item.title}</span>
            {item.count > 0 && (
              <span className="ml-1 px-1.5 py-0 rounded-full bg-foreground/10 text-muted-foreground font-mono text-[9px]">
                {item.count}
              </span>
            )}
            {item.extra && (
              <span className="text-[9px] text-muted-foreground normal-case font-normal ml-1">
                {item.extra}
              </span>
            )}
          </div>
        );
      }

      return (
        <LogEntry
          entry={item.entry}
          isSelected={selectedSha === item.entry.sha}
          isHead={headSha === item.entry.sha}
          isPushable={item.isPushable}
          onSelect={handleSelect}
          onContextMenu={handleContextMenu}
        />
      );
    },
    [sectionIcons, selectedSha, headSha, handleSelect, handleContextMenu]
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Branch status header */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border/30 text-xs">
        <GitBranch className="h-3.5 w-3.5 text-green-400 shrink-0" />
        <span className="font-mono text-foreground font-medium truncate">{branchName}</span>
        {upstream && (
          <span className="text-muted-foreground text-[10px] truncate">
            &#8594; {upstream}
          </span>
        )}
        <div className="flex items-center gap-1.5 ml-auto shrink-0">
          {ahead > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 font-medium">
              <ArrowUp className="h-2.5 w-2.5" />
              {ahead}
            </span>
          )}
          {behind > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 font-medium">
              <ArrowDown className="h-2.5 w-2.5" />
              {behind}
            </span>
          )}
          <button
            className="p-0.5 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowSearch(!showSearch)}
            title="Search commits"
          >
            <Search className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Search input */}
      {showSearch && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/30 bg-accent/5">
          <Search className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            className="flex-1 bg-transparent border-none text-xs text-foreground placeholder:text-muted-foreground focus:outline-none font-mono"
            placeholder="Search commits..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
          />
          {searchQuery && (
            <span className="text-[10px] text-muted-foreground shrink-0">
              {filteredAhead.length + filteredRecent.length} results
            </span>
          )}
        </div>
      )}

      {/* Create branch input (shown after context menu action) */}
      {createBranchInput.show && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/30 bg-accent/10">
          <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            className="flex-1 bg-background/50 border border-border/50 rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
            placeholder={`Branch from ${createBranchInput.sha.slice(0, 7)}...`}
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateBranch();
              if (e.key === 'Escape') {
                setCreateBranchInput({ sha: '', show: false });
                setNewBranchName('');
              }
            }}
            autoFocus
          />
          <button
            className="px-2 py-1 rounded text-[11px] bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            disabled={!newBranchName.trim() || actionLoading}
            onClick={handleCreateBranch}
          >
            {actionLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Create'}
          </button>
        </div>
      )}

      {/* Commit list (virtualized) */}
      <div className="flex-1 overflow-hidden">
        {loading && entries.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading commits...
          </div>
        )}
        {!loading && entries.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
            No commits found
          </div>
        )}

        {virtualItems.length > 0 && (
          <Virtuoso
            data={virtualItems}
            itemContent={renderVirtualItem}
            style={{ height: '100%' }}
            overscan={200}
          />
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <GitContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={buildCommitContextActions(contextMenu.entry)}
          onClose={handleCloseContextMenu}
        />
      )}
    </div>
  );
});
