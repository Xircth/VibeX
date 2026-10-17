import { memo, useCallback, useEffect, useRef } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';

interface GitDiscardDialogProps {
  open: boolean;
  files: string[];
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

export const GitDiscardDialog = memo(function GitDiscardDialog({
  open,
  files,
  onConfirm,
  onCancel,
  loading = false,
}: GitDiscardDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      confirmRef.current?.focus();
    }
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) {
        onCancel();
      }
    },
    [onCancel, loading]
  );

  if (!open) return null;

  const isAll = files.length === 0;
  const title = isAll
    ? 'Discard All Changes'
    : `Discard ${files.length} File${files.length > 1 ? 's' : ''}`;

  return (
    <div
      data-floating-layer="modal"
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={handleKeyDown}
    >
      <NativeSurfaceOcclusionHold />
      <div
        className="dialog-backdrop fixed inset-0"
        aria-hidden="true"
        onClick={() => {
          if (!loading) onCancel();
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-discard-dialog-title"
        className="modal-surface relative z-10 border border-border rounded-lg shadow-xl w-[340px] max-h-[80vh] flex flex-col animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
          <span
            id="git-discard-dialog-title"
            className="text-sm font-medium text-foreground flex-1"
          >
            {title}
          </span>
          <button
            type="button"
            aria-label="Close"
            className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            onClick={onCancel}
            disabled={loading}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-2">
          <p className="text-xs text-destructive font-medium">
            This action cannot be undone.
          </p>
          <p className="text-xs text-muted-foreground">
            {isAll
              ? 'All unstaged changes will be permanently discarded.'
              : 'The following files will have their changes permanently discarded:'}
          </p>

          {files.length > 0 && (
            <div className="max-h-[120px] overflow-y-auto rounded bg-secondary/50 border border-border/30 p-2 space-y-0.5">
              {files.map((f) => (
                <div
                  key={f}
                  className="text-[10px] font-mono text-muted-foreground truncate"
                  title={f}
                >
                  {f}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border/50">
          <button
            className="raised-control px-3 py-1.5 text-xs font-medium disabled:opacity-40"
            onClick={onCancel}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            className="px-3 py-1.5 rounded text-xs font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-40"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? 'Discarding...' : 'Discard'}
          </button>
        </div>
      </div>
    </div>
  );
});
