import { memo, useCallback, useEffect } from 'react';
import { X, Columns2, Rows3 } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { GitFileDiffEntry } from 'shared/types';
import { DiffBlock, type DiffStyle } from './DiffBlock';
import { ImageDiffCard } from './ImageDiffCard';

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  A: { label: 'Added', color: 'text-green-500' },
  M: { label: 'Modified', color: 'text-yellow-500' },
  D: { label: 'Deleted', color: 'text-red-500' },
  R: { label: 'Renamed', color: 'text-blue-500' },
};

interface GitDiffModalProps {
  entry: GitFileDiffEntry | null;
  diffStyle: DiffStyle;
  onToggleDiffStyle: () => void;
  onClose: () => void;
}

export const GitDiffModal = memo(function GitDiffModal({
  entry,
  diffStyle,
  onToggleDiffStyle,
  onClose,
}: GitDiffModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (!entry) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [entry, handleKeyDown]);

  if (!entry) return null;

  const st = STATUS_LABELS[entry.status] ?? { label: entry.status, color: 'text-muted-foreground' };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
    >
      {/* Title bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/50 shrink-0">
        <span className={`font-bold text-xs ${st.color}`}>{st.label}</span>
        <span className="font-mono text-sm text-foreground truncate flex-1">{entry.path}</span>

        <button
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          onClick={onToggleDiffStyle}
          title={diffStyle === 'unified' ? 'Switch to split view' : 'Switch to unified view'}
        >
          {diffStyle === 'unified' ? (
            <>
              <Columns2 className="h-3.5 w-3.5" />
              <span>Split</span>
            </>
          ) : (
            <>
              <Rows3 className="h-3.5 w-3.5" />
              <span>Unified</span>
            </>
          )}
        </button>

        <button
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          onClick={onClose}
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Diff content */}
      <div className="flex-1 overflow-auto min-h-0 p-2">
        {entry.is_image ? (
          <ImageDiffCard path={entry.path} status={entry.status} />
        ) : entry.is_binary ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground italic">
            Binary file not shown
          </div>
        ) : entry.diff ? (
          <DiffBlock diff={entry.diff} diffStyle={diffStyle} />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground italic">
            Empty diff
          </div>
        )}
      </div>
    </div>,
    document.body
  );
});
