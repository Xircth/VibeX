import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEventHandler,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import './zoomableImagePreview.css';
import { ImagePreviewToolbar } from './ImagePreviewToolbar';
import {
  actualSizeScale,
  applyViewScale,
  canPanImage,
  clampOffset,
  FIT_SCALE,
  getContainedSize,
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
  imagePointToViewport,
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

function cloneAnnotation(annotation: Annotation): Annotation {
  if (annotation.kind === 'stroke') {
    return {
      ...annotation,
      points: annotation.points.map((point) => ({ ...point })),
    };
  }
  return { ...annotation };
}

function cloneAnnotations(annotations: readonly Annotation[]) {
  return annotations.map(cloneAnnotation);
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
  const annotationsRef = useRef<Annotation[]>([]);
  const [viewportSize, setViewportSize] = useState<Size>({
    width: 0,
    height: 0,
  });
  const [naturalSize, setNaturalSize] = useState<Size>({ width: 0, height: 0 });
  const [scale, setScale] = useState(FIT_SCALE);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [tool, setTool] = useState<AnnotationTool>('view');
  const [markKind, setMarkKind] = useState<'rect' | 'ellipse'>('rect');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const historyRef = useRef<Annotation[][]>([[]]);
  const historyIndexRef = useRef(0);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [historySize, setHistorySize] = useState(1);
  const [markOpen, setMarkOpen] = useState(false);
  const [brushOpen, setBrushOpen] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
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
  annotationsRef.current = annotations;

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
    setScale(FIT_SCALE);
    setOffset({ x: 0, y: 0 });
    setNaturalSize({ width: 0, height: 0 });
    setIsDragging(false);
    setAnnotations([]);
    annotationsRef.current = [];
    historyRef.current = [[]];
    historyIndexRef.current = 0;
    setHistoryIndex(0);
    setHistorySize(1);
    setDraft(null);
    setSelectedId(null);
    setEditingTextId(null);
    setDraggingAnnotationId(null);
    setTool('view');
    setMarkKind('rect');
    setMarkOpen(false);
    setBrushOpen(false);
    setTextOpen(false);
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
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
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
    setScale(FIT_SCALE);
    setOffset({ x: 0, y: 0 });
  };

  const syncHistoryMeta = useCallback((index: number, size: number) => {
    historyIndexRef.current = index;
    setHistoryIndex(index);
    setHistorySize(size);
  }, []);

  const commitAnnotations = useCallback(
    (next: Annotation[]) => {
      annotationsRef.current = next;
      setAnnotations(next);
      const stack = historyRef.current.slice(0, historyIndexRef.current + 1);
      const previous = stack[stack.length - 1];
      if (JSON.stringify(previous) === JSON.stringify(next)) {
        return;
      }
      stack.push(cloneAnnotations(next));
      if (stack.length > 50) {
        stack.shift();
      }
      historyRef.current = stack;
      syncHistoryMeta(stack.length - 1, stack.length);
    },
    [syncHistoryMeta]
  );

  const undoAnnotations = useCallback(() => {
    if (historyIndexRef.current <= 0) {
      return;
    }
    const nextIndex = historyIndexRef.current - 1;
    const next = cloneAnnotations(historyRef.current[nextIndex] ?? []);
    annotationsRef.current = next;
    setAnnotations(next);
    syncHistoryMeta(nextIndex, historyRef.current.length);
    setSelectedId(null);
    setEditingTextId(null);
    setDraft(null);
  }, [syncHistoryMeta]);

  const redoAnnotations = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) {
      return;
    }
    const nextIndex = historyIndexRef.current + 1;
    const next = cloneAnnotations(historyRef.current[nextIndex] ?? []);
    annotationsRef.current = next;
    setAnnotations(next);
    syncHistoryMeta(nextIndex, historyRef.current.length);
    setSelectedId(null);
    setEditingTextId(null);
    setDraft(null);
  }, [syncHistoryMeta]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      if (
        !typing &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'z'
      ) {
        event.preventDefault();
        if (event.shiftKey) {
          redoAnnotations();
        } else {
          undoAnnotations();
        }
        return;
      }
      if (
        !typing &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'y'
      ) {
        event.preventDefault();
        redoAnnotations();
        return;
      }
      if (event.key !== 'Backspace' && event.key !== 'Delete') {
        return;
      }
      if (editingTextId || typing) {
        return;
      }
      const currentSelectedId = viewRef.current.selectedId;
      if (!currentSelectedId) {
        return;
      }
      event.preventDefault();
      commitAnnotations(
        annotationsRef.current.filter(
          (annotation) => annotation.id !== currentSelectedId
        )
      );
      setSelectedId(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commitAnnotations, editingTextId, redoAnnotations, undoAnnotations]);

  const closeToolPopovers = () => {
    setMarkOpen(false);
    setBrushOpen(false);
    setTextOpen(false);
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
    const selectedAnnotationId = viewRef.current.selectedId;
    const next = annotationsRef.current.map((annotation) =>
      annotation.id === selectedAnnotationId
        ? applyAnnotationStyle(annotation, patch)
        : annotation
    );
    commitAnnotations(next);
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
    closeToolPopovers();
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
      setAnnotations((current) => {
        const next = current.map((annotation) =>
          annotation.id === session.id
            ? moveAnnotation(annotation, dx, dy, viewRef.current.naturalSize)
            : annotation
        );
        annotationsRef.current = next;
        return next;
      });
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
        commitAnnotations([...annotationsRef.current, currentDraft]);
      } else {
        setSelectedId(null);
      }
    }

    if (session.type === 'move') {
      if (!session.moved) {
        const target = annotationsRef.current.find(
          (annotation) => annotation.id === session.id
        );
        if (target?.kind === 'text') {
          setEditingTextId(target.id);
        }
      } else {
        commitAnnotations(annotationsRef.current);
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
  const editingText = annotations.find(
    (annotation): annotation is Extract<Annotation, { kind: 'text' }> =>
      annotation.kind === 'text' && annotation.id === editingTextId
  );
  const editingTextBox = editingText
    ? (() => {
        const origin = imagePointToViewport(
          { x: editingText.x, y: editingText.y },
          viewportSize,
          fittedSize,
          scale,
          offset,
          naturalSize
        );
        const displayScale =
          naturalSize.width > 0
            ? (fittedSize.width * scale) / naturalSize.width
            : 1;
        return {
          left: origin.x,
          top: origin.y,
          width: Math.max(editingText.width * displayScale, 48),
          minHeight: textAnnotationHeight(editingText) * displayScale,
          fontSize: editingText.fontSize * displayScale,
        };
      })()
    : null;

  return (
    <div className={cn('relative h-full min-h-0 w-full', className)}>
      <ImagePreviewToolbar
        annotate={annotate}
        chromeVisible={chromeVisible}
        tool={tool}
        markKind={markKind}
        color={selected?.color ?? color}
        strokeWidth={
          selected && (selected.kind === 'rect' || selected.kind === 'ellipse')
            ? selected.strokeWidth
            : strokeWidth
        }
        brushSize={selected?.kind === 'stroke' ? selected.size : brushSize}
        fontSize={selected?.kind === 'text' ? selected.fontSize : fontSize}
        scale={scale}
        canUndo={historyIndex > 0}
        canRedo={historyIndex < historySize - 1}
        markOpen={markOpen}
        brushOpen={brushOpen}
        textOpen={textOpen}
        onToolChange={(nextTool) => {
          setTool(nextTool);
          if (nextTool === 'rect' || nextTool === 'ellipse') {
            setMarkKind(nextTool);
          }
        }}
        onMarkKindChange={(kind) => {
          setMarkKind(kind);
          setTool(kind);
        }}
        onColorChange={(nextColor) => applyStylePatch({ color: nextColor })}
        onStrokeWidthChange={(value) => applyStylePatch({ strokeWidth: value })}
        onBrushSizeChange={(value) => applyStylePatch({ size: value })}
        onFontSizeChange={(value) => applyStylePatch({ fontSize: value })}
        onScaleChange={(nextScale) => applyScale(nextScale)}
        onFit={resetView}
        onUndo={undoAnnotations}
        onRedo={redoAnnotations}
        onToggleChrome={() => setChromeVisible((visible) => !visible)}
        onMarkOpenChange={setMarkOpen}
        onBrushOpenChange={setBrushOpen}
        onTextOpenChange={setTextOpen}
      />

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
          if (scale === FIT_SCALE) {
            applyScale(Math.min(oneToOneScale, 2));
            return;
          }
          resetView();
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
                  if (editingTextId === annotation.id) {
                    return null;
                  }
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
                      <span className="pointer-events-none">
                        {annotation.text}
                      </span>
                    </div>
                  );
                })
            : null}
        </div>
        {editingText && editingTextBox ? (
          <textarea
            ref={textInputRef}
            data-testid="image-preview-text-editor"
            value={editingText.text}
            autoFocus
            placeholder={t('imagePreview.textPlaceholder')}
            className="image-preview-text-editor"
            style={{
              left: editingTextBox.left,
              top: editingTextBox.top,
              width: editingTextBox.width,
              minHeight: editingTextBox.minHeight,
              fontSize: editingTextBox.fontSize,
              lineHeight: 1.3,
              color: editingText.color,
              fontFamily: 'system-ui, "SF Pro Text", "PingFang SC", sans-serif',
            }}
            onChange={(event) => {
              const text = event.target.value;
              setAnnotations((current) => {
                const next = current.map((item) =>
                  item.id === editingText.id && item.kind === 'text'
                    ? { ...item, text }
                    : item
                );
                annotationsRef.current = next;
                return next;
              });
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onBlur={() => {
              setEditingTextId(null);
              const current = annotationsRef.current.find(
                (item) => item.id === editingText.id
              );
              if (
                !current ||
                current.kind !== 'text' ||
                current.text.trim().length === 0
              ) {
                const next = annotationsRef.current.filter(
                  (item) => item.id !== editingText.id
                );
                annotationsRef.current = next;
                setAnnotations(next);
                setSelectedId(null);
                return;
              }
              commitAnnotations(annotationsRef.current);
            }}
          />
        ) : null}
      </div>

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
