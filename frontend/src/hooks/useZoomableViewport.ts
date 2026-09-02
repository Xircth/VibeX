import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEventHandler,
  type RefObject,
  type WheelEventHandler,
} from 'react';

export type ViewportSize = {
  width: number;
  height: number;
};

export type ViewportOffset = {
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

export type ZoomableViewportOptions = {
  minScale?: number;
  maxScale?: number;
  scaleStep?: number;
  resetKey?: string | number;
};

const DEFAULT_MIN_SCALE = 1;
const DEFAULT_MAX_SCALE = 8;
const DEFAULT_SCALE_STEP = 0.25;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getContainedSize(content: ViewportSize, viewport: ViewportSize) {
  if (
    content.width <= 0 ||
    content.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return { width: 0, height: 0, fitRatio: 1 };
  }

  const fitRatio = Math.min(
    viewport.width / content.width,
    viewport.height / content.height,
    1
  );

  return {
    width: content.width * fitRatio,
    height: content.height * fitRatio,
    fitRatio,
  };
}

function clampOffset(
  offset: ViewportOffset,
  scale: number,
  fitted: ViewportSize,
  viewport: ViewportSize
) {
  const scaledWidth = fitted.width * scale;
  const scaledHeight = fitted.height * scale;
  const maxOffsetX = Math.max(0, (scaledWidth - viewport.width) / 2);
  const maxOffsetY = Math.max(0, (scaledHeight - viewport.height) / 2);

  return {
    x: maxOffsetX === 0 ? 0 : clamp(offset.x, -maxOffsetX, maxOffsetX),
    y: maxOffsetY === 0 ? 0 : clamp(offset.y, -maxOffsetY, maxOffsetY),
  };
}

export function useZoomableViewport(
  contentSize: ViewportSize,
  options: ZoomableViewportOptions = {}
) {
  const minScale = options.minScale ?? DEFAULT_MIN_SCALE;
  const maxScale = options.maxScale ?? DEFAULT_MAX_SCALE;
  const scaleStep = options.scaleStep ?? DEFAULT_SCALE_STEP;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [viewportSize, setViewportSize] = useState<ViewportSize>({
    width: 0,
    height: 0,
  });
  const [scale, setScale] = useState(minScale);
  const [offset, setOffset] = useState<ViewportOffset>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const fittedSize = useMemo(
    () => getContainedSize(contentSize, viewportSize),
    [contentSize, viewportSize]
  );
  const actualSizeScale = useMemo(
    () => Math.max(minScale, 1 / fittedSize.fitRatio),
    [fittedSize.fitRatio, minScale]
  );
  const canPan =
    fittedSize.width * scale > viewportSize.width ||
    fittedSize.height * scale > viewportSize.height;

  useEffect(() => {
    setScale(minScale);
    setOffset({ x: 0, y: 0 });
    setIsDragging(false);
    dragStateRef.current = null;
  }, [minScale, options.resetKey]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return undefined;
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

    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setOffset((currentOffset) =>
      clampOffset(currentOffset, scale, fittedSize, viewportSize)
    );
  }, [fittedSize, scale, viewportSize]);

  const applyScale = (nextScale: number, anchor?: ViewportOffset) => {
    const normalizedScale = clamp(nextScale, minScale, maxScale);

    if (
      normalizedScale === minScale ||
      fittedSize.width === 0 ||
      fittedSize.height === 0
    ) {
      setScale(minScale);
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
    setScale(minScale);
    setOffset({ x: 0, y: 0 });
  };

  const zoomIn = () => applyScale(scale + scaleStep);
  const zoomOut = () => applyScale(scale - scaleStep);
  const zoomToActualSize = () => applyScale(actualSizeScale);
  const toggleFitOrZoom = () =>
    applyScale(scale > minScale ? minScale : Math.min(actualSizeScale, 2));

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
    applyScale(scale + direction * scaleStep, anchor);
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

  return {
    viewportRef: viewportRef as RefObject<HTMLDivElement>,
    fittedSize,
    scale,
    offset,
    canPan,
    isDragging,
    zoomPercent: Math.round(scale * 100),
    zoomIn,
    zoomOut,
    zoomToActualSize,
    resetView,
    toggleFitOrZoom,
    handleWheel,
    handlePointerDown,
    handlePointerMove,
    handlePointerEnd,
    minScale,
    maxScale,
  };
}
