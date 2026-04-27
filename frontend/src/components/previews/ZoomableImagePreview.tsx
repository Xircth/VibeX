import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEventHandler,
  type WheelEventHandler,
} from 'react';
import { Maximize2, Minus, Move, Plus, ScanSearch, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const SCALE_STEP = 0.25;

type Size = {
  width: number;
  height: number;
};

type Offset = {
  x: number;
  y: number;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getContainedSize(natural: Size, viewport: Size) {
  if (
    natural.width <= 0 ||
    natural.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return { width: 0, height: 0, fitRatio: 1 };
  }

  const fitRatio = Math.min(
    viewport.width / natural.width,
    viewport.height / natural.height,
    1
  );

  return {
    width: natural.width * fitRatio,
    height: natural.height * fitRatio,
    fitRatio,
  };
}

function clampOffset(offset: Offset, scale: number, fitted: Size, viewport: Size) {
  const scaledWidth = fitted.width * scale;
  const scaledHeight = fitted.height * scale;
  const maxOffsetX = Math.max(0, (scaledWidth - viewport.width) / 2);
  const maxOffsetY = Math.max(0, (scaledHeight - viewport.height) / 2);

  return {
    x: maxOffsetX === 0 ? 0 : clamp(offset.x, -maxOffsetX, maxOffsetX),
    y: maxOffsetY === 0 ? 0 : clamp(offset.y, -maxOffsetY, maxOffsetY),
  };
}

type ZoomableImagePreviewProps = {
  src: string;
  alt: string;
  className?: string;
  viewportClassName?: string;
};

export function ZoomableImagePreview({
  src,
  alt,
  className,
  viewportClassName,
}: ZoomableImagePreviewProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [viewportSize, setViewportSize] = useState<Size>({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState<Size>({ width: 0, height: 0 });
  const [scale, setScale] = useState(MIN_SCALE);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const fittedSize = useMemo(
    () => getContainedSize(naturalSize, viewportSize),
    [naturalSize, viewportSize]
  );
  const actualSizeScale = useMemo(
    () => Math.max(MIN_SCALE, 1 / fittedSize.fitRatio),
    [fittedSize.fitRatio]
  );
  const canPan =
    fittedSize.width * scale > viewportSize.width ||
    fittedSize.height * scale > viewportSize.height;

  useEffect(() => {
    setScale(MIN_SCALE);
    setOffset({ x: 0, y: 0 });
    setNaturalSize({ width: 0, height: 0 });
    setIsDragging(false);
    dragStateRef.current = null;
  }, [src]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const updateViewportSize = () => {
      setViewportSize({
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      });
    };

    updateViewportSize();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateViewportSize);
      return () => window.removeEventListener('resize', updateViewportSize);
    }

    const observer = new ResizeObserver(() => {
      updateViewportSize();
    });
    observer.observe(viewport);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setOffset((currentOffset) =>
      clampOffset(currentOffset, scale, fittedSize, viewportSize)
    );
  }, [fittedSize, scale, viewportSize]);

  const applyScale = (nextScale: number, anchor?: { x: number; y: number }) => {
    const normalizedScale = clamp(nextScale, MIN_SCALE, MAX_SCALE);

    if (
      normalizedScale === MIN_SCALE ||
      fittedSize.width === 0 ||
      fittedSize.height === 0
    ) {
      setScale(MIN_SCALE);
      setOffset({ x: 0, y: 0 });
      return;
    }

    if (!anchor) {
      setScale(normalizedScale);
      setOffset((currentOffset) =>
        clampOffset(currentOffset, normalizedScale, fittedSize, viewportSize)
      );
      return;
    }

    const nextOffset = {
      x: anchor.x - ((anchor.x - offset.x) / scale) * normalizedScale,
      y: anchor.y - ((anchor.y - offset.y) / scale) * normalizedScale,
    };

    setScale(normalizedScale);
    setOffset(clampOffset(nextOffset, normalizedScale, fittedSize, viewportSize));
  };

  const resetView = () => {
    setScale(MIN_SCALE);
    setOffset({ x: 0, y: 0 });
  };

  const handleWheel: WheelEventHandler<HTMLDivElement> = (event) => {
    if (fittedSize.width === 0 || fittedSize.height === 0) {
      return;
    }

    event.preventDefault();

    const rect = event.currentTarget.getBoundingClientRect();
    const anchor = {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    };
    const direction = event.deltaY < 0 ? 1 : -1;
    applyScale(scale + direction * SCALE_STEP, anchor);
  };

  const handlePointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
    if (!canPan) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove: PointerEventHandler<HTMLDivElement> = (event) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const nextOffset = {
      x: dragState.originX + (event.clientX - dragState.startX),
      y: dragState.originY + (event.clientY - dragState.startY),
    };
    setOffset(clampOffset(nextOffset, scale, fittedSize, viewportSize));
  };

  const handlePointerEnd: PointerEventHandler<HTMLDivElement> = (event) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    dragStateRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const zoomPercent = Math.round(scale * 100);

  return (
    <div className={cn('relative h-full w-full', className)}>
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-lg border border-border/70 bg-background/90 p-1 shadow-sm backdrop-blur">
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
          onClick={() => applyScale(scale - SCALE_STEP)}
          disabled={scale <= MIN_SCALE}
          aria-label="Zoom out image"
          title="Zoom out"
        >
          <Minus className="h-4 w-4" />
        </button>
        <span className="min-w-[3.5rem] select-none text-center text-[11px] font-medium text-foreground/80">
          {zoomPercent}%
        </span>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
          onClick={() => applyScale(scale + SCALE_STEP)}
          disabled={scale >= MAX_SCALE}
          aria-label="Zoom in image"
          title="Zoom in"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="inline-flex h-8 items-center justify-center rounded-md px-2 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
          onClick={() => applyScale(actualSizeScale)}
          aria-label="View image at actual size"
          title="1:1"
        >
          <Maximize2 className="mr-1 h-3.5 w-3.5" />
          1:1
        </button>
        <button
          type="button"
          className="inline-flex h-8 items-center justify-center rounded-md px-2 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
          onClick={resetView}
          aria-label="Reset image view"
          title="Fit to viewport"
        >
          <Undo2 className="mr-1 h-3.5 w-3.5" />
          Fit
        </button>
      </div>

      <div
        ref={viewportRef}
        className={cn(
          'relative h-full w-full overflow-hidden rounded-lg bg-background/60',
          canPan
            ? isDragging
              ? 'cursor-grabbing'
              : 'cursor-grab'
            : 'cursor-default',
          viewportClassName
        )}
        style={{ touchAction: 'none' }}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onDoubleClick={() =>
          applyScale(scale > MIN_SCALE ? MIN_SCALE : Math.min(actualSizeScale, 2))
        }
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="pointer-events-none absolute left-1/2 top-1/2 select-none rounded-lg shadow-[0_18px_60px_rgba(15,23,42,0.25)]"
          style={{
            width: fittedSize.width || undefined,
            height: fittedSize.height || undefined,
            transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: 'center center',
          }}
          onLoad={(event) => {
            setNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            });
          }}
        />
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-lg border border-border/60 bg-background/85 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
        <ScanSearch className="h-3.5 w-3.5" />
        <span>Wheel to zoom</span>
        <span className="text-muted-foreground/50">/</span>
        <span className={cn(canPan ? 'text-foreground/80' : '')}>
          Drag to pan
        </span>
        {canPan ? (
          <>
            <span className="text-muted-foreground/50">/</span>
            <Move className="h-3.5 w-3.5" />
          </>
        ) : null}
      </div>
    </div>
  );
}
