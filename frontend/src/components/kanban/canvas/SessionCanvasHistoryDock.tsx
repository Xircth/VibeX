import { Redo2, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const DOCK_BUTTON_SHAPE =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors';

const DOCK_BUTTON = `${DOCK_BUTTON_SHAPE} text-muted-foreground hover:bg-[var(--surface-control-hover)] hover:text-foreground disabled:pointer-events-none disabled:opacity-40`;

export function SessionCanvasHistoryDock({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const { t } = useTranslation(['tasks']);

  return (
    <div
      className={cn(
        'flex items-center gap-0.5 rounded-full border border-border',
        'bg-[var(--surface-card-strong)] p-1 shadow-[var(--shadow-popover)]'
      )}
      role="toolbar"
      aria-label={t('hubCanvas.historyDock')}
    >
      <button
        type="button"
        className={DOCK_BUTTON}
        onClick={onUndo}
        disabled={!canUndo}
        aria-label={t('hubCanvas.undo')}
        title={t('hubCanvas.undo')}
      >
        <Undo2 className="size-4" />
      </button>
      <button
        type="button"
        className={DOCK_BUTTON}
        onClick={onRedo}
        disabled={!canRedo}
        aria-label={t('hubCanvas.redo')}
        title={t('hubCanvas.redo')}
      >
        <Redo2 className="size-4" />
      </button>
    </div>
  );
}
