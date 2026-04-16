import { memo } from 'react';
import { FileText, Loader2, Plus, Minus } from 'lucide-react';
import type { CommitDetail, CommitFileEntry } from 'shared/types';

interface CommitDetailPanelProps {
  detail: CommitDetail | null;
  loading: boolean;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

function statusColor(status: string): string {
  switch (status.charAt(0).toUpperCase()) {
    case 'A':
      return 'text-green-400 bg-green-400/10';
    case 'D':
      return 'text-red-400 bg-red-400/10';
    case 'M':
      return 'text-yellow-400 bg-yellow-400/10';
    case 'R':
      return 'text-blue-400 bg-blue-400/10';
    default:
      return 'text-muted-foreground bg-muted/20';
  }
}

const FileRow = memo(function FileRow({ file }: { file: CommitFileEntry }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-[11px] hover:bg-accent/20 transition-colors">
      <span
        className={`inline-flex items-center justify-center w-4 h-4 rounded text-[9px] font-bold shrink-0 ${statusColor(file.status)}`}
      >
        {file.status.charAt(0).toUpperCase()}
      </span>
      <span className="flex-1 truncate font-mono text-foreground/80">
        {file.path}
      </span>
      <span className="flex items-center gap-1 shrink-0 text-[10px]">
        {file.additions > 0 && (
          <span className="text-green-400 flex items-center gap-0.5">
            <Plus className="h-2.5 w-2.5" />
            {file.additions}
          </span>
        )}
        {file.deletions > 0 && (
          <span className="text-red-400 flex items-center gap-0.5">
            <Minus className="h-2.5 w-2.5" />
            {file.deletions}
          </span>
        )}
      </span>
    </div>
  );
});

export const CommitDetailPanel = memo(function CommitDetailPanel({
  detail,
  loading,
}: CommitDetailPanelProps) {
  if (loading) {
    return (
      <div className="border-t border-border/30 bg-background/30">
        <div className="flex items-center justify-center py-6 text-muted-foreground text-xs gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading commit details...
        </div>
      </div>
    );
  }

  if (!detail) return null;

  const totalAdditions = detail.files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = detail.files.reduce((sum, f) => sum + f.deletions, 0);

  return (
    <div className="border-t border-border/30 bg-background/30">
      {/* Commit metadata */}
      <div className="px-3 py-2 space-y-1.5 border-b border-border/20">
        {/* Title */}
        <div className="text-xs font-medium text-foreground leading-snug">
          {detail.summary}
        </div>

        {/* Body (if any) */}
        {detail.body && (
          <div className="text-[11px] text-muted-foreground whitespace-pre-wrap leading-relaxed max-h-24 overflow-y-auto">
            {detail.body}
          </div>
        )}

        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          <span>
            <span className="text-foreground/60">Author</span>{' '}
            <span className="text-foreground/80">{detail.author}</span>
          </span>
          <span>
            <span className="text-foreground/60">Email</span>{' '}
            <span className="font-mono text-foreground/80">
              {detail.author_email}
            </span>
          </span>
          <span>
            <span className="text-foreground/60">Date</span>{' '}
            <span>{formatTimestamp(detail.timestamp)}</span>
          </span>
          <span>
            <span className="text-foreground/60">SHA</span>{' '}
            <button
              className="font-mono text-foreground/80 hover:text-foreground transition-colors"
              onClick={() => navigator.clipboard.writeText(detail.sha)}
              title="Copy full SHA"
            >
              {detail.sha.slice(0, 12)}
            </button>
          </span>
        </div>
      </div>

      {/* Changed files */}
      <div>
        <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/20 bg-background/50">
          <FileText className="h-3 w-3" />
          <span>Changed Files</span>
          <span className="text-muted-foreground/60">
            ({detail.files.length})
          </span>
          <div className="flex-1" />
          <span className="flex items-center gap-1 font-mono font-normal normal-case">
            <span className="text-green-400">+{totalAdditions}</span>
            <span className="text-muted-foreground/40">/</span>
            <span className="text-red-400">-{totalDeletions}</span>
          </span>
        </div>
        <div className="max-h-48 overflow-y-auto">
          {detail.files.map((file) => (
            <FileRow key={file.path} file={file} />
          ))}
        </div>
      </div>
    </div>
  );
});
