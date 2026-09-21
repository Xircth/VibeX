import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEventHandler,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ChevronsLeft,
  ChevronsRight,
  Circle,
  Maximize2,
  Minus,
  Move,
  Paintbrush,
  Plus,
  ScanSearch,
  Square,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import './zoomableImagePreview.css';
import {
  actualSizeScale,
  applyViewScale,
  canPanImage,
  clampOffset,
  getContainedSize,
  MAX_SCALE,
  MIN_SCALE,
  SCALE_STEP,
  type Offset,
  type Size,
} from './imagePreviewViewport';
import {
  ANNOTATION_BRUSH_OPACITY,
  appendBrushPoint,
  applyAnnotationStyle,
  annotationHasArea,
  createBrushAnnotation,
  createEllipseAnnotation,
  createRectAnnotation,
  createTextAnnotation,
  DEFAULT_ANNOTATION_COLOR,
  DEFAULT_BRUSH_SIZE,
  DEFAULT_FONT_SIZE,
  DEFAULT_STROKE_WIDTH,
  fileFromAnnotatedImage,
  hitTestAnnotation,
  moveAnnotation,
  textAnnotationHeight,
  viewportPointToImage,
  type Annotation,
  type AnnotationTool,
  type Point,
} from './imagePreviewAnnotations';
import {
  clearCurrentDraggedAnnotatedImage,
  dispatchAnnotatedImageDrop,
  LONG_PRESS_MS,
  setCurrentDraggedAnnotatedImage,
  shouldCancelLongPress,
  updateAnnotatedImageDragPointer,
} from './imagePreviewDrag';

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
};

type PointerSession =
  | {
      type: 'pan';
      pointerId: number;
    }
  | {
      type: 'draw';
      pointerId: number;
      start: Point;
      startX: number;
      startY: number;
    }
  | {
      type: 'move';
      pointerId: number;
      id: string;
      last: Point;
      moved: boolean;
    }
  | {
      type: 'longpress';
      pointerId: number;
      startX: number;
      startY: number;
    }
  | {
      type: 'file-drag';
      pointerId: number;
    };

type ZoomableImagePreviewProps = {
  src: string;
  alt: string;
  className?: string;
  viewportClassName?: string;
  annotate?: boolean;
  /** Overlay / dialog previewers start with chrome stowed. Workspace tabs do not. */
  chromeDefaultVisible?: boolean;
};

function readElementSize(element: HTMLElement): Size {
  const rect = element.getBoundingClientRect();
  return {
    width: element.clientWidth || rect.width,
    height: element.clientHeight || rect.height,
  };
}

function createAnnotationId() {
  return `ann-${Math.random().toString(36).slice(2, 10)}`;
}

function fileStemFromAlt(alt: string) {
  const name = alt.split(/[\\/]/).at(-1)?.trim();
  return name || 'image';
}

export function ZoomableImagePreview({
  src,
  alt,
  className,
  viewportClassName,
  annotate = true,
  chromeDefaultVisible = true,
}: ZoomableImagePreviewProps) {
  const { t } = useTranslation('conversation');
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const sessionRef = useRef<PointerSession | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  const ghostUrlRef = useRef<string | null>(null);
  const draftRef = useRef<Annotation | null>(null);
  const [viewportSize, setViewportSize] = useState<Size>({
    width: 0,
    height: 0,
  });
  const [naturalSize, setNaturalSize] = useState<Size>({ width: 0, height: 0 });
  const [scale, setScale] = useState(MIN_SCALE);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [tool, setTool] = useState<AnnotationTool>('view');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [color, setColor] = useState(DEFAULT_ANNOTATION_COLOR);
  const [strokeWidth, setStrokeWidth] = useState(DEFAULT_STROKE_WIDTH);
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [draggingAnnotationId, setDraggingAnnotationId] = useState<
    string | null
  >(null);
  const [ghost, setGhost] = useState<{
    url: string;
    x: number;
    y: number;
  } | null>(null);
  const [chromeVisible, setChromeVisible] = useState(chromeDefaultVisible);

  const fittedSize = useMemo(
    () => getContainedSize(naturalSize, viewportSize),
    [naturalSize, viewportSize]
  );
  const oneToOneScale = useMemo(
    () => actualSizeScale(fittedSize.fitRatio),
    [fittedSize.fitRatio]
  );
  const canPan = canPanImage(scale, fittedSize, viewportSize);
  const visibleAnnotations = draft ? [...annotations, draft] : annotations;
  const selected = annotations.find(
    (annotation) => annotation.id === selectedId
  );
  const viewRef = useRef({
    scale,
    offset,
    fittedSize,
    viewportSize,
    naturalSize,
    canPan,
    tool,
    annotate,
    annotations,
    color,
    strokeWidth,
    brushSize,
    fontSize,
    selectedId,
    src,
    alt,
  });
  viewRef.current = {
    scale,
    offset,
    fittedSize,
    viewportSize,
    naturalSize,
    canPan,
    tool,
    annotate,
    annotations,
    color,
    strokeWidth,
    brushSize,
    fontSize,
    selectedId,
    src,
    alt,
  };
  draftRef.current = draft;

  const syncNaturalSize = (image: HTMLImageElement) => {
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      return;
    }

    setNaturalSize((current) =>
      current.width === image.naturalWidth &&
      current.height === image.naturalHeight
        ? current
        : { width: image.naturalWidth, height: image.naturalHeight }
    );
  };

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const clearGhost = () => {
    if (ghostUrlRef.current) {
      URL.revokeObjectURL(ghostUrlRef.current);
      ghostUrlRef.current = null;
    }
    setGhost(null);
  };

  useEffect(() => {
    setScale(MIN_SCALE);
    setOffset({ x: 0, y: 0 });
    setNaturalSize({ width: 0, height: 0 });
    setIsDragging(false);
    setAnnotations([]);
    setDraft(null);
    setSelectedId(null);
    setEditingTextId(null);
    setDraggingAnnotationId(null);
    setTool('view');
    setChromeVisible(chromeDefaultVisible);
    dragStateRef.current = null;
    sessionRef.current = null;
    clearLongPress();
    clearGhost();
    clearCurrentDraggedAnnotatedImage();

    const image = imageRef.current;
    if (image?.complete) {
      syncNaturalSize(image);
    }
  }, [chromeDefaultVisible, src]);

  useEffect(() => {
    return () => {
      clearLongPress();
      clearGhost();
      clearCurrentDraggedAnnotatedImage();
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const updateViewportSize = () => {
      const nextSize = readElementSize(viewport);
      setViewportSize((current) =>
        current.width === nextSize.width && current.height === nextSize.height
          ? current
          : nextSize
      );
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

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      const view = viewRef.current;
      if (view.fittedSize.width === 0 || view.fittedSize.height === 0) {
        return;
      }

      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const nextView = applyViewScale({
        currentOffset: view.offset,
        currentScale: view.scale,
        nextScale: view.scale + (event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP),
        fitted: view.fittedSize,
        viewport: view.viewportSize,
        anchor: {
          x: event.clientX - rect.left - rect.width / 2,
          y: event.clientY - rect.top - rect.height / 2,
        },
      });
      setScale(nextView.scale);
      setOffset(nextView.offset);
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    if (!editingTextId) {
      return;
    }
    textInputRef.current?.focus();
  }, [editingTextId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Backspace' && event.key !== 'Delete') {
        return;
      }
      if (editingTextId) {
        return;
      }
      if (!(event.target instanceof HTMLElement)) {
        return;
      }
      if (
        event.target.tagName === 'INPUT' ||
        event.target.tagName === 'TEXTAREA'
      ) {
        return;
      }
      const currentSelectedId = viewRef.current.selectedId;
      if (!currentSelectedId) {
        return;
      }
      event.preventDefault();
      setAnnotations((current) =>
        current.filter((annotation) => annotation.id !== currentSelectedId)
      );
      setSelectedId(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editingTextId]);

  const applyScale = (nextScale: number, anchor?: Offset) => {
    const view = viewRef.current;
    const nextView = applyViewScale({
      currentOffset: view.offset,
      currentScale: view.scale,
      nextScale,
      fitted: view.fittedSize,
      viewport: view.viewportSize,
      anchor,
    });
    setScale(nextView.scale);
    setOffset(nextView.offset);
  };

  const resetView = () => {
    setScale(MIN_SCALE);
    setOffset({ x: 0, y: 0 });
  };

  const imagePointFromPointer = (event: {
    clientX: number;
    clientY: number;
  }): Point => {
    const viewport = viewportRef.current;
    const view = viewRef.current;
    if (!viewport) {
      return { x: 0, y: 0 };
    }
    return viewportPointToImage(
      { x: event.clientX, y: event.clientY },
      viewport.getBoundingClientRect(),
      view.viewportSize,
      view.fittedSize,
      view.scale,
      view.offset,
      view.naturalSize
    );
  };

  const applyStylePatch = (patch: {
    color?: string;
    strokeWidth?: number;
    size?: number;
    fontSize?: number;
  }) => {
    if (patch.color) {
      setColor(patch.color);
    }
    if (patch.strokeWidth !== undefined) {
      setStrokeWidth(patch.strokeWidth);
    }
    if (patch.size !== undefined) {
      setBrushSize(patch.size);
    }
    if (patch.fontSize !== undefined) {
      setFontSize(patch.fontSize);
    }
    setAnnotations((current) =>
      current.map((annotation) =>
        annotation.id === viewRef.current.selectedId
          ? applyAnnotationStyle(annotation, patch)
          : annotation
      )
    );
    setDraft((current) =>
      current ? applyAnnotationStyle(current, patch) : current
    );
  };

  const beginFileDrag = async (
    pointerId: number,
    clientX: number,
    clientY: number
  ) => {
    const view = viewRef.current;
    if (!view.annotate) {
      return;
    }
    try {
      const file = await fileFromAnnotatedImage({
        src: view.src,
        naturalSize: view.naturalSize,
        annotations: view.annotations,
        fileName: fileStemFromAlt(view.alt),
      });
      const session = sessionRef.current;
      if (
        !session ||
        (session.type !== 'longpress' && session.type !== 'file-drag') ||
        session.pointerId !== pointerId
      ) {
        return;
      }
      const url =
        typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(file)
          : '';
      if (ghostUrlRef.current) {
        URL.revokeObjectURL(ghostUrlRef.current);
      }
      ghostUrlRef.current = url || null;
      if (url) {
        setGhost({ url, x: clientX, y: clientY });
      }
      sessionRef.current = { type: 'file-drag', pointerId };
      dragStateRef.current = null;
      setIsDragging(false);
      setCurrentDraggedAnnotatedImage(file);
      updateAnnotatedImageDragPointer({ x: clientX, y: clientY });
    } catch {
      clearGhost();
      clearCurrentDraggedAnnotatedImage();
    }
  };

  const handlePointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
    if (event.button !== 0) {
      return;
    }
    if (event.target instanceof HTMLTextAreaElement) {
      return;
    }

    const view = viewRef.current;
    const point = imagePointFromPointer(event);
    const hitId = view.annotate
      ? hitTestAnnotation(view.annotations, point)
      : null;

    clearLongPress();
    setEditingTextId((current) => (hitId === current ? current : null));

    if (view.annotate && hitId) {
      sessionRef.current = {
        type: 'move',
        pointerId: event.pointerId,
        id: hitId,
        last: point,
        moved: false,
      };
      setSelectedId(hitId);
      setDraggingAnnotationId(hitId);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }

    if (view.annotate && view.tool !== 'view') {
      const id = createAnnotationId();
      if (view.tool === 'text') {
        const annotation = createTextAnnotation({
          id,
          point,
          color: view.color,
          fontSize: view.fontSize,
        });
        setAnnotations((current) => [...current, annotation]);
        setSelectedId(id);
        setEditingTextId(id);
        sessionRef.current = null;
        return;
      }
      const nextDraft =
        view.tool === 'brush'
          ? createBrushAnnotation({
              id,
              point,
              color: view.color,
              size: view.brushSize,
            })
          : view.tool === 'ellipse'
            ? createEllipseAnnotation({
                id,
                start: point,
                end: point,
                color: view.color,
                strokeWidth: view.strokeWidth,
              })
            : createRectAnnotation({
                id,
                start: point,
                end: point,
                color: view.color,
                strokeWidth: view.strokeWidth,
              });
      sessionRef.current = {
        type: 'draw',
        pointerId: event.pointerId,
        start: point,
        startX: event.clientX,
        startY: event.clientY,
      };
      setDraft(nextDraft);
      setSelectedId(id);
      longPressTimerRef.current = window.setTimeout(() => {
        setDraft(null);
        sessionRef.current = {
          type: 'longpress',
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
        };
        void beginFileDrag(event.pointerId, event.clientX, event.clientY);
      }, LONG_PRESS_MS);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }

    sessionRef.current = {
      type: 'longpress',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    if (view.annotate) {
      longPressTimerRef.current = window.setTimeout(() => {
        void beginFileDrag(event.pointerId, event.clientX, event.clientY);
      }, LONG_PRESS_MS);
    }
    if (view.canPan) {
      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: offset.x,
        originY: offset.y,
      };
      setIsDragging(true);
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove: PointerEventHandler<HTMLDivElement> = (event) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    if (session.type === 'file-drag') {
      setGhost((current) =>
        current ? { ...current, x: event.clientX, y: event.clientY } : current
      );
      updateAnnotatedImageDragPointer({ x: event.clientX, y: event.clientY });
      return;
    }

    if (session.type === 'longpress') {
      const distance = Math.hypot(
        event.clientX - session.startX,
        event.clientY - session.startY
      );
      if (shouldCancelLongPress(distance)) {
        clearLongPress();
        if (dragStateRef.current) {
          sessionRef.current = { type: 'pan', pointerId: event.pointerId };
        } else {
          sessionRef.current = null;
        }
      }
    }

    if (session.type === 'draw') {
      if (
        shouldCancelLongPress(
          Math.hypot(
            event.clientX - session.startX,
            event.clientY - session.startY
          )
        )
      ) {
        clearLongPress();
      }
      const point = imagePointFromPointer(event);
      setDraft((current) => {
        if (!current) {
          return current;
        }
        if (current.kind === 'stroke') {
          return appendBrushPoint(current, point);
        }
        if (current.kind === 'text') {
          return current;
        }
        return current.kind === 'ellipse'
          ? createEllipseAnnotation({
              id: current.id,
              start: session.start,
              end: point,
              color: current.color,
              strokeWidth: current.strokeWidth,
            })
          : createRectAnnotation({
              id: current.id,
              start: session.start,
              end: point,
              color: current.color,
              strokeWidth: current.strokeWidth,
            });
      });
      return;
    }

    if (session.type === 'move') {
      const point = imagePointFromPointer(event);
      const dx = point.x - session.last.x;
      const dy = point.y - session.last.y;
      if (dx === 0 && dy === 0) {
        return;
      }
      sessionRef.current = {
        ...session,
        last: point,
        moved: true,
      };
      setAnnotations((current) =>
        current.map((annotation) =>
          annotation.id === session.id
            ? moveAnnotation(annotation, dx, dy, viewRef.current.naturalSize)
            : annotation
        )
      );
      return;
    }

    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const view = viewRef.current;
    setOffset(
      clampOffset(
        {
          x: dragState.originX + (event.clientX - dragState.startX),
          y: dragState.originY + (event.clientY - dragState.startY),
        },
        view.scale,
        view.fittedSize,
        view.viewportSize
      )
    );
  };

  const handlePointerEnd: PointerEventHandler<HTMLDivElement> = (event) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    clearLongPress();

    if (session.type === 'file-drag') {
      dispatchAnnotatedImageDrop(event.clientX, event.clientY);
      clearCurrentDraggedAnnotatedImage();
      clearGhost();
    }

    if (session.type === 'draw') {
      const currentDraft = draftRef.current;
      setDraft(null);
      if (currentDraft && annotationHasArea(currentDraft)) {
        setAnnotations((existing) => [...existing, currentDraft]);
      } else {
        setSelectedId(null);
      }
    }

    if (session.type === 'move') {
      if (!session.moved) {
        const target = annotations.find(
          (annotation) => annotation.id === session.id
        );
        if (target?.kind === 'text') {
          setEditingTextId(target.id);
        }
      }
      setDraggingAnnotationId(null);
    }

    sessionRef.current = null;
    dragStateRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const zoomPercent = Math.round(scale * 100);
  const imageBoxStyle =
    fittedSize.width > 0 && fittedSize.height > 0
      ? {
          width: fittedSize.width,
          height: fittedSize.height,
          maxWidth: 'none' as const,
          maxHeight: 'none' as const,
        }
      : {
          width: '100%',
          height: '100%',
          maxWidth: 'none' as const,
          maxHeight: 'none' as const,
        };
  const fitRatio =
    naturalSize.width > 0 ? fittedSize.width / naturalSize.width : 1;
  const drawing = tool !== 'view';
  const canGrab = canPan && !drawing && !draggingAnnotationId && !ghost;
  const showStyleControls = annotate && (tool !== 'view' || Boolean(selected));

  return (
    <div className={cn('relative h-full min-h-0 w-full', className)}>
      <div className="absolute right-3 top-3 z-10">
        <div
          className="image-preview-chrome image-preview-zoom-dock"
          data-testid="image-preview-zoom-dock"
          data-stowed={chromeVisible ? 'false' : 'true'}
        >
          <div className="image-preview-zoom-tools pr-1">
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
              onClick={() => applyScale(scale - SCALE_STEP)}
              disabled={scale <= MIN_SCALE}
              aria-label={t('imagePreview.zoomOut')}
              title={t('imagePreview.zoomOut')}
            >
              <Minus className="h-4 w-4" />
            </button>
            <span className="min-w-[3.5rem] select-none text-center text-[11px] font-medium text-foreground/80">
              {zoomPercent}%
            </span>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
              onClick={() => applyScale(scale + SCALE_STEP)}
              disabled={scale >= MAX_SCALE}
              aria-label={t('imagePreview.zoomIn')}
              title={t('imagePreview.zoomIn')}
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-[var(--radius)] px-2 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
              onClick={() => applyScale(oneToOneScale)}
              aria-label={t('imagePreview.actualSizeAria')}
              title={t('imagePreview.actualSize')}
            >
              <Maximize2 className="mr-1 h-3.5 w-3.5" />
              {t('imagePreview.actualSize')}
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-[var(--radius)] px-2 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
              onClick={resetView}
              aria-label={t('imagePreview.fitAria')}
              title={t('imagePreview.fit')}
            >
              <Undo2 className="mr-1 h-3.5 w-3.5" />
              {t('imagePreview.fit')}
            </button>
          </div>
          <button
            type="button"
            className="image-preview-chrome-toggle inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition hover:bg-muted hover:text-foreground"
            onClick={() => setChromeVisible((visible) => !visible)}
            aria-expanded={chromeVisible}
            aria-label={
              chromeVisible
                ? t('imagePreview.hideChrome')
                : t('imagePreview.showChrome')
            }
            title={
              chromeVisible
                ? t('imagePreview.hideChrome')
                : t('imagePreview.showChrome')
            }
          >
            {chromeVisible ? (
              <ChevronsRight className="h-4 w-4" />
            ) : (
              <ChevronsLeft className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {annotate && chromeVisible ? (
        <div className="absolute left-3 top-3 z-10 flex max-w-[calc(100%-9rem)] flex-col gap-1">
          <div className="image-preview-chrome flex items-center gap-1 p-1">
            <ToolButton
              label={t('imagePreview.toolView')}
              active={tool === 'view'}
              onClick={() => setTool('view')}
            >
              <Move className="h-4 w-4" />
            </ToolButton>
            <ToolButton
              label={t('imagePreview.toolRect')}
              active={tool === 'rect'}
              onClick={() => setTool('rect')}
            >
              <Square className="h-4 w-4" />
            </ToolButton>
            <ToolButton
              label={t('imagePreview.toolEllipse')}
              active={tool === 'ellipse'}
              onClick={() => setTool('ellipse')}
            >
              <Circle className="h-4 w-4" />
            </ToolButton>
            <ToolButton
              label={t('imagePreview.toolBrush')}
              active={tool === 'brush'}
              onClick={() => setTool('brush')}
            >
              <Paintbrush className="h-4 w-4" />
            </ToolButton>
            <ToolButton
              label={t('imagePreview.toolText')}
              active={tool === 'text'}
              onClick={() => setTool('text')}
            >
              <Type className="h-4 w-4" />
            </ToolButton>
            {selected ? (
              <ToolButton
                label={t('imagePreview.deleteAnnotation')}
                onClick={() => {
                  setAnnotations((current) =>
                    current.filter(
                      (annotation) => annotation.id !== selected.id
                    )
                  );
                  setSelectedId(null);
                  setEditingTextId(null);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </ToolButton>
            ) : null}
          </div>
          {showStyleControls ? (
            <div className="image-preview-chrome flex items-center gap-2 px-2 py-1">
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="sr-only">{t('imagePreview.color')}</span>
                <input
                  type="color"
                  value={selected?.color ?? color}
                  onChange={(event) =>
                    applyStylePatch({ color: event.target.value })
                  }
                  className="h-6 w-6 cursor-pointer rounded-md border border-border bg-transparent p-0"
                />
              </label>
              {tool === 'brush' || selected?.kind === 'stroke' ? (
                <RangeControl
                  label={t('imagePreview.brushSize')}
                  value={
                    selected?.kind === 'stroke' ? selected.size : brushSize
                  }
                  min={6}
                  max={48}
                  onChange={(value) => applyStylePatch({ size: value })}
                />
              ) : tool === 'text' || selected?.kind === 'text' ? (
                <RangeControl
                  label={t('imagePreview.fontSize')}
                  value={
                    selected?.kind === 'text' ? selected.fontSize : fontSize
                  }
                  min={14}
                  max={72}
                  onChange={(value) => applyStylePatch({ fontSize: value })}
                />
              ) : (
                <RangeControl
                  label={t('imagePreview.strokeWidth')}
                  value={
                    selected &&
                    (selected.kind === 'rect' || selected.kind === 'ellipse')
                      ? selected.strokeWidth
                      : strokeWidth
                  }
                  min={2}
                  max={20}
                  onChange={(value) => applyStylePatch({ strokeWidth: value })}
                />
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        ref={viewportRef}
        data-testid="image-preview-viewport"
        className={cn(
          'absolute inset-0 overflow-hidden overscroll-none rounded-[var(--radius)] bg-background/60',
          ghost
            ? 'cursor-grabbing'
            : drawing
              ? 'cursor-crosshair'
              : canGrab
                ? isDragging
                  ? 'cursor-grabbing'
                  : 'cursor-grab'
                : 'cursor-default',
          viewportClassName
        )}
        style={{ touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onDoubleClick={() => {
          if (tool !== 'view') {
            return;
          }
          applyScale(
            scale > MIN_SCALE ? MIN_SCALE : Math.min(oneToOneScale, 2)
          );
        }}
      >
        <div
          data-testid="image-preview-stage"
          className="absolute left-1/2 top-1/2"
          style={{
            ...imageBoxStyle,
            transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: 'center center',
          }}
        >
          <img
            ref={imageRef}
            src={src}
            alt={alt}
            draggable={false}
            className="pointer-events-none absolute inset-0 h-full w-full select-none"
            style={{
              maxWidth: 'none',
              maxHeight: 'none',
              objectFit: fittedSize.width > 0 ? 'fill' : 'contain',
            }}
            onLoad={(event) => {
              syncNaturalSize(event.currentTarget);
            }}
          />
          {naturalSize.width > 0 && naturalSize.height > 0 ? (
            <svg
              data-testid="image-preview-annotation-layer"
              className="pointer-events-none absolute inset-0 h-full w-full"
              viewBox={`0 0 ${naturalSize.width} ${naturalSize.height}`}
              preserveAspectRatio="none"
            >
              {visibleAnnotations.map((annotation) => {
                if (annotation.kind === 'rect') {
                  return (
                    <rect
                      key={annotation.id}
                      x={annotation.x}
                      y={annotation.y}
                      width={annotation.width}
                      height={annotation.height}
                      fill="none"
                      stroke={annotation.color}
                      strokeWidth={annotation.strokeWidth}
                    />
                  );
                }
                if (annotation.kind === 'ellipse') {
                  return (
                    <ellipse
                      key={annotation.id}
                      cx={annotation.x + annotation.width / 2}
                      cy={annotation.y + annotation.height / 2}
                      rx={annotation.width / 2}
                      ry={annotation.height / 2}
                      fill="none"
                      stroke={annotation.color}
                      strokeWidth={annotation.strokeWidth}
                    />
                  );
                }
                if (annotation.kind === 'stroke') {
                  const [first, ...rest] = annotation.points;
                  if (!first) {
                    return null;
                  }
                  if (rest.length === 0) {
                    return (
                      <circle
                        key={annotation.id}
                        cx={first.x}
                        cy={first.y}
                        r={annotation.size / 2}
                        fill={annotation.color}
                        opacity={ANNOTATION_BRUSH_OPACITY}
                      />
                    );
                  }
                  return (
                    <polyline
                      key={annotation.id}
                      points={[first, ...rest]
                        .map((point) => `${point.x},${point.y}`)
                        .join(' ')}
                      fill="none"
                      stroke={annotation.color}
                      strokeWidth={annotation.size}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={ANNOTATION_BRUSH_OPACITY}
                    />
                  );
                }
                return null;
              })}
            </svg>
          ) : null}
          {naturalSize.width > 0
            ? visibleAnnotations
                .filter(
                  (
                    annotation
                  ): annotation is Extract<Annotation, { kind: 'text' }> =>
                    annotation.kind === 'text'
                )
                .map((annotation) => {
                  const isEditing = editingTextId === annotation.id;
                  const isDraggingText = draggingAnnotationId === annotation.id;
                  return (
                    <div
                      key={annotation.id}
                      data-testid={`image-preview-text-${annotation.id}`}
                      className={cn(
                        'absolute overflow-visible whitespace-pre-wrap break-words',
                        isDraggingText && 'rounded-sm ring-1 ring-foreground/70'
                      )}
                      style={{
                        left: annotation.x * fitRatio,
                        top: annotation.y * fitRatio,
                        width: annotation.width * fitRatio,
                        minHeight: textAnnotationHeight(annotation) * fitRatio,
                        color: annotation.color,
                        fontSize: annotation.fontSize * fitRatio,
                        lineHeight: 1.3,
                        fontFamily:
                          'system-ui, "SF Pro Text", "PingFang SC", sans-serif',
                      }}
                    >
                      {isEditing ? (
                        <textarea
                          ref={textInputRef}
                          value={annotation.text}
                          placeholder={t('imagePreview.textPlaceholder')}
                          className="h-full min-h-[1em] w-full resize-none border-0 bg-transparent p-0 text-inherit outline-none"
                          style={{
                            fontSize: 'inherit',
                            lineHeight: 'inherit',
                            color: 'inherit',
                          }}
                          onChange={(event) => {
                            const text = event.target.value;
                            setAnnotations((current) =>
                              current.map((item) =>
                                item.id === annotation.id &&
                                item.kind === 'text'
                                  ? { ...item, text }
                                  : item
                              )
                            );
                          }}
                          onPointerDown={(event) => event.stopPropagation()}
                          onBlur={() => {
                            setEditingTextId(null);
                            setAnnotations((current) =>
                              current.filter(
                                (item) =>
                                  item.id !== annotation.id ||
                                  item.kind !== 'text' ||
                                  item.text.trim().length > 0
                              )
                            );
                          }}
                        />
                      ) : (
                        <span className="pointer-events-none">
                          {annotation.text}
                        </span>
                      )}
                    </div>
                  );
                })
            : null}
        </div>
      </div>

      {chromeVisible ? (
        <div className="image-preview-chrome pointer-events-none absolute bottom-3 left-3 z-10 flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          <ScanSearch className="h-3.5 w-3.5" />
          <span>{t('imagePreview.wheelToZoom')}</span>
          <span className="text-muted-foreground/50">/</span>
          <span className={cn(canPan ? 'text-foreground/80' : '')}>
            {t('imagePreview.dragToPan')}
          </span>
          {canPan ? (
            <>
              <span className="text-muted-foreground/50">/</span>
              <Move className="h-3.5 w-3.5" />
            </>
          ) : null}
          {annotate ? (
            <>
              <span className="text-muted-foreground/50">/</span>
              <span>{t('imagePreview.holdToInsert')}</span>
            </>
          ) : null}
        </div>
      ) : null}

      {ghost
        ? createPortal(
            <img
              src={ghost.url}
              alt=""
              className="pointer-events-none fixed z-[80] h-24 w-auto rounded-lg border border-border/70 shadow-lg"
              style={{
                left: ghost.x,
                top: ghost.y,
                transform: 'translate(-50%, -50%) rotate(6deg)',
                opacity: 0.92,
              }}
            />,
            document.body
          )
        : null}
    </div>
  );
}

function ToolButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md transition',
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-muted-foreground">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        aria-label={label}
        className="h-1 w-full accent-primary"
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
