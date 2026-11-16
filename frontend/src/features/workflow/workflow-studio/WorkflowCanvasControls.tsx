import { useStore, useReactFlow } from '@xyflow/react';
import {
  Hand,
  Map as MapIcon,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export type CanvasInteractionTool = 'pan' | 'select';

export function WorkflowCanvasControls({
  tool,
  onToolChange,
  miniMapOpen,
  onToggleMiniMap,
}: {
  tool: CanvasInteractionTool;
  onToolChange: (next: CanvasInteractionTool) => void;
  miniMapOpen: boolean;
  onToggleMiniMap: () => void;
}) {
  const { t } = useTranslation('workflow');
  const reactFlow = useReactFlow();
  const zoomPercent = useStore((state) =>
    Math.round((state.transform?.[2] ?? 1) * 100)
  );

  return (
    <div
      data-testid="workflow-canvas-controls"
      className="nopan nodrag workflow-studio-floating-controls pointer-events-auto absolute bottom-3.5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border bg-[var(--surface-card-strong)] p-1 shadow-[var(--shadow-popover)]"
    >
      <button
        type="button"
        data-testid="workflow-canvas-tool-select"
        aria-pressed={tool === 'select'}
        aria-label={t('studio.canvasSelectTool')}
        title={t('studio.canvasSelectTool')}
        onClick={() => onToolChange('select')}
        className={cn(
          'grid size-7 place-items-center rounded-full transition-colors',
          tool === 'select'
            ? 'bg-muted text-foreground shadow-2xs'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
        )}
      >
        <MousePointer2 className="size-3.5" />
      </button>
      <button
        type="button"
        data-testid="workflow-canvas-tool-pan"
        aria-pressed={tool === 'pan'}
        aria-label={t('studio.canvasPanTool')}
        title={t('studio.canvasPanTool')}
        onClick={() => onToolChange('pan')}
        className={cn(
          'grid size-7 place-items-center rounded-full transition-colors',
          tool === 'pan'
            ? 'bg-muted text-foreground shadow-2xs'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
        )}
      >
        <Hand className="size-3.5" />
      </button>

      <span className="mx-0.5 h-3.5 w-px bg-border/70" aria-hidden="true" />

      <button
        type="button"
        data-testid="workflow-canvas-zoom-out"
        aria-label={t('studio.canvasZoomOut')}
        title={t('studio.canvasZoomOut')}
        onClick={() => void reactFlow.zoomOut({ duration: 160 })}
        className="grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <Minus className="size-3.5" />
      </button>
      <button
        type="button"
        data-testid="workflow-canvas-zoom-reset"
        aria-label={t('studio.canvasZoomReset')}
        title={t('studio.canvasZoomReset')}
        onClick={() => void reactFlow.zoomTo(1, { duration: 160 })}
        className="flex h-7 min-w-[44px] items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        {zoomPercent}%
      </button>
      <button
        type="button"
        data-testid="workflow-canvas-zoom-in"
        aria-label={t('studio.canvasZoomIn')}
        title={t('studio.canvasZoomIn')}
        onClick={() => void reactFlow.zoomIn({ duration: 160 })}
        className="grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>

      <span className="mx-0.5 h-3.5 w-px bg-border/70" aria-hidden="true" />

      <button
        type="button"
        data-testid="workflow-canvas-fit-view"
        aria-label={t('studio.canvasFitView')}
        title={t('studio.canvasFitView')}
        onClick={() =>
          void reactFlow.fitView({
            padding: 0.24,
            maxZoom: 1.05,
            duration: 200,
          })
        }
        className="grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <Maximize2 className="size-3.5" />
      </button>
      <button
        type="button"
        data-testid="workflow-canvas-minimap-toggle"
        aria-pressed={miniMapOpen}
        aria-label={t('studio.canvasMiniMap')}
        title={t('studio.canvasMiniMap')}
        onClick={onToggleMiniMap}
        className={cn(
          'grid size-7 place-items-center rounded-full transition-colors',
          miniMapOpen
            ? 'bg-muted text-foreground shadow-2xs'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
        )}
      >
        <MapIcon className="size-3.5" />
      </button>
    </div>
  );
}
