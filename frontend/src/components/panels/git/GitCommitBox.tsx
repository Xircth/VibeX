import { memo, useCallback, useRef, useState } from 'react';
import { Upload, Loader2, ChevronsUpDown, ChevronsDownUp } from 'lucide-react';

interface GitCommitBoxProps {
  commitMessage: string;
  onCommitMessageChange: (msg: string) => void;
  hasStagedFiles: boolean;
  hasUnstagedFiles: boolean;
  commitLoading: boolean;
  pushLoading: boolean;
  commitError: string | null;
  pushError: string | null;
  commitsAhead?: number;
  onCommit: () => void;
  onCommitAndPush: () => void;
  onPush?: () => void;
}

export const GitCommitBox = memo(function GitCommitBox({
  commitMessage,
  onCommitMessageChange,
  hasStagedFiles,
  hasUnstagedFiles,
  commitLoading,
  pushLoading,
  commitError,
  pushError,
  commitsAhead = 0,
  onCommit,
  onCommitAndPush,
  onPush,
}: GitCommitBoxProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  const hasMessage = commitMessage.trim().length > 0;
  const hasChanges = hasStagedFiles || hasUnstagedFiles;
  const canCommit = hasMessage && hasChanges && !commitLoading;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (canCommit) {
          if (e.shiftKey) {
            onCommitAndPush();
          } else {
            onCommit();
          }
        }
      }
    },
    [canCommit, onCommit, onCommitAndPush]
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  const commitTitle = !hasMessage
    ? 'Enter a commit message'
    : !hasChanges
    ? 'No changes to commit'
    : commitLoading
    ? 'Committing...'
    : 'Commit (Ctrl+Enter)';

  return (
    <div className="flex flex-col border-b border-border/50">
      {/* Collapsed header bar */}
      <div
        className="flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-accent/30 transition-colors"
        onClick={toggleCollapsed}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleCollapsed(); }}
      >
        {collapsed ? (
          <ChevronsUpDown className="h-3 w-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronsDownUp className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex-1">
          Commit
        </span>
        {collapsed && commitsAhead > 0 && (
          <span className="text-[10px] text-muted-foreground">
            <Upload className="h-3 w-3 inline mr-0.5" />{commitsAhead}
          </span>
        )}
      </div>

      {/* Expanded content */}
      {!collapsed && (
        <div className="flex flex-col gap-1.5 px-2 pb-1.5">
          {/* Commit message input */}
          <div className="relative">
            <textarea
              ref={textareaRef}
              className="w-full resize-none bg-background/50 border border-border/50 rounded px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
              placeholder="Commit message..."
              rows={2}
              value={commitMessage}
              onChange={(e) => onCommitMessageChange(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>

          {/* Error display */}
          {(commitError || pushError) && (
            <div className="text-[10px] text-destructive px-0.5">
              {commitError || pushError}
            </div>
          )}

          {/* Commit buttons */}
          <div className="flex items-center gap-1">
            <button
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              disabled={!canCommit}
              onClick={onCommit}
              title={commitTitle}
            >
              {commitLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                'Commit'
              )}
            </button>
            <button
              className="flex items-center justify-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              disabled={!canCommit}
              onClick={onCommitAndPush}
              title="Commit and Push (Ctrl+Shift+Enter)"
            >
              {pushLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <>Commit & Push</>
              )}
            </button>
          </div>

          {/* Push indicator */}
          {commitsAhead > 0 && (
            <button
              className="flex items-center justify-center gap-1 px-2 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
              onClick={onPush}
              title={`Push ${commitsAhead} commit${commitsAhead > 1 ? 's' : ''}`}
            >
              <Upload className="h-3 w-3" />
              <span>Push {commitsAhead} commit{commitsAhead > 1 ? 's' : ''}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
});
