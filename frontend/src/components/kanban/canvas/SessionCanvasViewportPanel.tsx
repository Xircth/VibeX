import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MiniMap, Panel, useReactFlow, useStore } from '@xyflow/react';
import { CircleMinus, CirclePlus, Map as MapIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { saveMinimapVisible } from './canvasStorage';

const ZOOM_STEP_DURATION_MS = 150;
const MINIMAP_ASPECT = 150 / 200;
const MINIMAP_FALLBACK_WIDTH = 200;
const ZOOM_EPSILON = 0.001;

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const DOCK_BUTTON_SHAPE =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors';

const DOCK_BUTTON = `${DOCK_BUTTON_SHAPE} text-muted-foreground hover:bg-[var(--surface-control-hover)] hover:text-foreground disabled:pointer-events-none disabled:opacity-40`;

const DOCK_BUTTON_PRESSED = `${DOCK_BUTTON_SHAPE} bg-primary text-primary-foreground disabled:pointer-events-none disabled:opacity-40`;

function ViewportButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={pressed ? DOCK_BUTTON_PRESSED : DOCK_BUTTON}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
    >
      {children}
    </button>
  );
}

export function SessionCanvasViewportPanel({
  mapVisible,
  onMapVisibleChange,
}: {
  mapVisible: boolean;
  onMapVisibleChange: (visible: boolean) => void;
}) {
  const { t } = useTranslation(['tasks']);
  const { zoomIn, zoomOut, zoomTo } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const [pillWidth, setPillWidth] = useState(0);

  useIsomorphicLayoutEffect(() => {
    const element = pillRef.current;
    if (!element) return;
    const measure = () => setPillWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const mapWidth = pillWidth || MINIMAP_FALLBACK_WIDTH;

  return (
    <Panel position="bottom-right" data-canvas-export-skip="">
      <div className="flex flex-col items-end gap-2">
        {mapVisible ? (
          <MiniMap
            pannable
            zoomable
            className="canvas-minimap"
            style={{
              position: 'static',
              margin: 0,
              width: mapWidth,
              height: Math.round(mapWidth * MINIMAP_ASPECT),
            }}
          />
        ) : null}
        <div
          ref={pillRef}
          className={cn(
            'flex items-center gap-0.5 rounded-full border border-border',
            'bg-[var(--surface-card-strong)] p-1 shadow-[var(--shadow-popover)]'
          )}
          role="toolbar"
          aria-label={t('hubCanvas.viewportControls')}
        >
          <ViewportButton
            label={
              mapVisible
                ? t('hubCanvas.hideMinimap')
                : t('hubCanvas.showMinimap')
            }
            pressed={mapVisible}
            onClick={() => {
              const next = !mapVisible;
              onMapVisibleChange(next);
              saveMinimapVisible(next);
            }}
          >
            <MapIcon className="size-4" />
          </ViewportButton>
          <span
            className="mx-1 h-5 w-px shrink-0 bg-border"
            aria-hidden="true"
          />
          <ViewportButton
            label={t('hubCanvas.zoomOut')}
            onClick={() => void zoomOut({ duration: ZOOM_STEP_DURATION_MS })}
            disabled={zoom <= minZoom + ZOOM_EPSILON}
          >
            <CircleMinus className="size-4" />
          </ViewportButton>
          <button
            type="button"
            className="inline-flex h-8 w-12 shrink-0 items-center justify-center rounded-full font-mono text-[0.6875rem] text-muted-foreground transition-colors hover:bg-[var(--surface-control-hover)] hover:text-foreground"
            onClick={() => void zoomTo(1, { duration: ZOOM_STEP_DURATION_MS })}
            aria-label={t('hubCanvas.resetZoom')}
            title={t('hubCanvas.resetZoom')}
          >
            {Math.round(zoom * 100)}%
          </button>
          <ViewportButton
            label={t('hubCanvas.zoomIn')}
            onClick={() => void zoomIn({ duration: ZOOM_STEP_DURATION_MS })}
            disabled={zoom >= maxZoom - ZOOM_EPSILON}
          >
            <CirclePlus className="size-4" />
          </ViewportButton>
        </div>
      </div>
    </Panel>
  );
}
