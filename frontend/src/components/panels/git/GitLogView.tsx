import { memo, useMemo } from 'react';
import { GitCommit, ArrowUp, ArrowDown } from 'lucide-react';
import type { GitLogEntry } from 'shared/types';

interface GitLogViewProps {
  entries: GitLogEntry[];
  total: number;
  ahead: number;
  behind: number;
  upstream: string | null;
  branchName: string;
  loading?: boolean;
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

const LogEntry = memo(function LogEntry({ entry }: { entry: GitLogEntry }) {
  return (
    <div className="flex items-start gap-2 px-2 py-1.5 hover:bg-accent/30 text-xs group">
      <GitCommit className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="text-foreground truncate leading-tight">{entry.summary}</span>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="font-mono">{entry.sha.slice(0, 7)}</span>
          <span>{entry.author}</span>
          <span>{formatRelativeTime(entry.timestamp)}</span>
        </div>
      </div>
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
        {sortedEntries.map((entry) => (
          <LogEntry key={entry.sha} entry={entry} />
        ))}
      </div>
    </div>
  );
});
