import { memo, useMemo, useCallback } from 'react';
import { GitCommit, ArrowUp, ArrowDown, Upload, Download, Copy } from 'lucide-react';
import type { GitLogEntry } from 'shared/types';

interface GitLogViewProps {
  entries: GitLogEntry[];
  total: number;
  ahead: number;
  behind: number;
  upstream: string | null;
  branchName: string;
  loading?: boolean;
  aheadEntries?: GitLogEntry[];
  behindEntries?: GitLogEntry[];
}

function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}w ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

const LogEntry = memo(function LogEntry({
  entry,
  onCopySha,
}: {
  entry: GitLogEntry;
  onCopySha?: (sha: string) => void;
}) {
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onCopySha?.(entry.sha);
    },
    [entry.sha, onCopySha]
  );

  const handleCopyClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(entry.sha);
    },
    [entry.sha]
  );

  return (
    <div
      className="flex items-start gap-2 px-2 py-1.5 hover:bg-accent/30 text-xs group"
      onContextMenu={handleContextMenu}
    >
      <GitCommit className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="text-foreground truncate leading-tight">{entry.summary}</span>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <button
            className="font-mono hover:text-foreground transition-colors flex items-center gap-0.5"
            onClick={handleCopyClick}
            title="Copy full SHA"
          >
            {entry.sha.slice(0, 7)}
            <Copy className="h-2.5 w-2.5 opacity-0 group-hover:opacity-60" />
          </button>
          <span>{entry.author}</span>
          <span>{formatRelativeTime(entry.timestamp)}</span>
        </div>
      </div>
    </div>
  );
});

interface SectionProps {
  title: string;
  icon: React.ReactNode;
  entries: GitLogEntry[];
  count: number;
  accentColor: string;
  onCopySha?: (sha: string) => void;
}

const LogSection = memo(function LogSection({
  title,
  icon,
  entries,
  count,
  accentColor,
  onCopySha,
}: SectionProps) {
  if (count === 0 || entries.length === 0) return null;

  return (
    <div className="flex flex-col">
      <div className={`flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider bg-background/50 border-b border-border/20 ${accentColor}`}>
        {icon}
        <span>{title}</span>
        <span className="text-muted-foreground/60">({count})</span>
      </div>
      {entries.map((entry) => (
        <LogEntry key={entry.sha} entry={entry} onCopySha={onCopySha} />
      ))}
    </div>
  );
});

export const GitLogView = memo(function GitLogView({
  entries,
  total,
  ahead,
  behind,
  upstream,
  branchName,
  loading,
}: GitLogViewProps) {
  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => b.timestamp - a.timestamp),
    [entries]
  );

  // Split entries into To Push / To Pull / Recent sections
  // ahead entries = first N entries (most recent), behind entries are not in local log
  const { aheadEntries, recentEntries } = useMemo(() => {
    if (ahead <= 0) {
      return { aheadEntries: [], recentEntries: sortedEntries };
    }
    return {
      aheadEntries: sortedEntries.slice(0, ahead),
      recentEntries: sortedEntries.slice(ahead),
    };
  }, [sortedEntries, ahead]);

  const handleCopySha = useCallback((sha: string) => {
    navigator.clipboard.writeText(sha);
  }, []);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Branch status header */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border/30 text-xs">
        <span className="font-mono text-foreground font-medium">{branchName}</span>
        {upstream && (
          <span className="text-muted-foreground text-[10px] truncate">
            &#8594; {upstream}
          </span>
        )}
        <div className="flex items-center gap-1.5 ml-auto shrink-0">
          {ahead > 0 && (
            <span className="flex items-center gap-0.5 text-green-400 text-[10px]">
              <ArrowUp className="h-3 w-3" />
              {ahead}
            </span>
          )}
          {behind > 0 && (
            <span className="flex items-center gap-0.5 text-yellow-400 text-[10px]">
              <ArrowDown className="h-3 w-3" />
              {behind}
            </span>
          )}
          <span className="text-muted-foreground text-[10px]">{total} commits</span>
        </div>
      </div>

      {/* Commit list */}
      <div className="flex-1 overflow-y-auto">
        {loading && entries.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
            Loading commits...
          </div>
        )}
        {!loading && entries.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
            No commits found
          </div>
        )}

        {/* To Push section */}
        <LogSection
          title="To Push"
          icon={<Upload className="h-3 w-3" />}
          entries={aheadEntries}
          count={ahead}
          accentColor="text-green-400"
          onCopySha={handleCopySha}
        />

        {/* To Pull indicator */}
        {behind > 0 && (
          <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider bg-background/50 border-b border-border/20 text-yellow-400">
            <Download className="h-3 w-3" />
            <span>To Pull</span>
            <span className="text-muted-foreground/60">({behind})</span>
            <span className="text-[9px] text-muted-foreground normal-case font-normal ml-1">
              Fetch or pull to see these commits
            </span>
          </div>
        )}

        {/* Recent Commits section */}
        {recentEntries.length > 0 && (
          <div className="flex flex-col">
            {(ahead > 0 || behind > 0) && (
              <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider bg-background/50 border-b border-border/20 text-muted-foreground">
                <GitCommit className="h-3 w-3" />
                <span>Recent Commits</span>
              </div>
            )}
            {recentEntries.map((entry) => (
              <LogEntry key={entry.sha} entry={entry} onCopySha={handleCopySha} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
