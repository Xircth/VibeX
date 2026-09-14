import type { Offset, Size } from './imagePreviewViewport';

export const ANNOTATION_BRUSH_OPACITY = 0.42;
export const MIN_ANNOTATION_SIZE = 4;
export const DEFAULT_ANNOTATION_COLOR = '#ff3b30';
export const DEFAULT_STROKE_WIDTH = 4;
export const DEFAULT_BRUSH_SIZE = 18;
export const DEFAULT_FONT_SIZE = 28;
export const TEXT_LINE_HEIGHT = 1.3;

export type Point = {
  x: number;
  y: number;
};

export type AnnotationTool = 'view' | 'rect' | 'ellipse' | 'brush' | 'text';

type AnnotationBase = {
  id: string;
  color: string;
};

export type RectAnnotation = AnnotationBase & {
  kind: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  strokeWidth: number;
};

export type EllipseAnnotation = AnnotationBase & {
  kind: 'ellipse';
  x: number;
  y: number;
  width: number;
  height: number;
  strokeWidth: number;
};

export type BrushAnnotation = AnnotationBase & {
  kind: 'stroke';
  points: Point[];
  size: number;
};

export type TextAnnotation = AnnotationBase & {
  kind: 'text';
  x: number;
  y: number;
  width: number;
  fontSize: number;
  text: string;
};

export type Annotation =
  | RectAnnotation
  | EllipseAnnotation
  | BrushAnnotation
  | TextAnnotation;

export type AnnotationStylePatch = {
  color?: string;
  strokeWidth?: number;
  size?: number;
  fontSize?: number;
};

export function rectFromPoints(start: Point, end: Point) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function createRectAnnotation({
  id,
  start,
  end,
  color,
  strokeWidth,
}: {
  id: string;
  start: Point;
  end: Point;
  color: string;
  strokeWidth: number;
}): RectAnnotation {
  return {
    id,
    kind: 'rect',
    color,
    strokeWidth,
    ...rectFromPoints(start, end),
  };
}

export function createEllipseAnnotation({
  id,
  start,
  end,
  color,
  strokeWidth,
}: {
  id: string;
  start: Point;
  end: Point;
  color: string;
  strokeWidth: number;
}): EllipseAnnotation {
  return {
    id,
    kind: 'ellipse',
    color,
    strokeWidth,
    ...rectFromPoints(start, end),
  };
}

export function createBrushAnnotation({
  id,
  point,
  color,
  size,
}: {
  id: string;
  point: Point;
  color: string;
  size: number;
}): BrushAnnotation {
  return {
    id,
    kind: 'stroke',
    color,
    size,
    points: [point],
  };
}

export function appendBrushPoint(
  annotation: BrushAnnotation,
  point: Point
): BrushAnnotation {
  const last = annotation.points[annotation.points.length - 1];
  if (last && last.x === point.x && last.y === point.y) {
    return annotation;
  }
  return {
    ...annotation,
    points: [...annotation.points, point],
  };
}

export function createTextAnnotation({
  id,
  point,
  color,
  fontSize,
  text = '',
  width,
}: {
  id: string;
  point: Point;
  color: string;
  fontSize: number;
  text?: string;
  width?: number;
}): TextAnnotation {
  return {
    id,
    kind: 'text',
    color,
    fontSize,
    text,
    x: point.x,
    y: point.y,
    width: width ?? Math.max(160, fontSize * 8),
  };
}

export function textAnnotationHeight(annotation: TextAnnotation) {
  const lines = Math.max(1, annotation.text.split('\n').length);
  return annotation.fontSize * TEXT_LINE_HEIGHT * lines;
}

export function annotationHasArea(annotation: Annotation) {
  if (annotation.kind === 'stroke') {
    return annotation.points.length > 0;
  }
  if (annotation.kind === 'text') {
    return annotation.text.trim().length > 0;
  }
  return (
    annotation.width >= MIN_ANNOTATION_SIZE &&
    annotation.height >= MIN_ANNOTATION_SIZE
  );
}

export function moveAnnotation(
  annotation: Annotation,
  dx: number,
  dy: number,
  bounds?: Size
): Annotation {
  if (annotation.kind === 'stroke') {
    return {
      ...annotation,
      points: annotation.points.map((point) =>
        clampPoint({ x: point.x + dx, y: point.y + dy }, bounds)
      ),
    };
  }

  const next = clampPoint(
    { x: annotation.x + dx, y: annotation.y + dy },
    bounds,
    annotation.kind === 'text'
      ? { width: annotation.width, height: textAnnotationHeight(annotation) }
      : { width: annotation.width, height: annotation.height }
  );
  return { ...annotation, x: next.x, y: next.y };
}

export function applyAnnotationStyle(
  annotation: Annotation,
  patch: AnnotationStylePatch
): Annotation {
  const color = patch.color ?? annotation.color;
  if (annotation.kind === 'stroke') {
    return {
      ...annotation,
      color,
      size: patch.size ?? patch.strokeWidth ?? annotation.size,
    };
  }
  if (annotation.kind === 'text') {
    return {
      ...annotation,
      color,
      fontSize: patch.fontSize ?? patch.size ?? annotation.fontSize,
    };
  }
  return {
    ...annotation,
    color,
    strokeWidth: patch.strokeWidth ?? patch.size ?? annotation.strokeWidth,
  };
}

export function hitTestAnnotation(
  annotations: readonly Annotation[],
  point: Point
): string | null {
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index];
    if (annotationContains(annotation, point)) {
      return annotation.id;
    }
  }
  return null;
}

export function viewportPointToImage(
  client: Point,
  viewportRect: { left: number; top: number },
  viewport: Size,
  fitted: Size,
  scale: number,
  offset: Offset,
  natural: Size
): Point {
  const displayedWidth = fitted.width * scale;
  const displayedHeight = fitted.height * scale;
  if (
    displayedWidth <= 0 ||
    displayedHeight <= 0 ||
    natural.width <= 0 ||
    natural.height <= 0
  ) {
    return { x: 0, y: 0 };
  }

  const originX = viewport.width / 2 + offset.x - displayedWidth / 2;
  const originY = viewport.height / 2 + offset.y - displayedHeight / 2;
  const localX = client.x - viewportRect.left - originX;
  const localY = client.y - viewportRect.top - originY;

  return {
    x: (localX / displayedWidth) * natural.width,
    y: (localY / displayedHeight) * natural.height,
  };
}

export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  annotations: readonly Annotation[],
  options: { draggingId?: string | null } = {}
) {
  for (const annotation of annotations) {
    ctx.save();
    if (annotation.kind === 'rect') {
      ctx.strokeStyle = annotation.color;
      ctx.lineWidth = annotation.strokeWidth;
      ctx.strokeRect(
        annotation.x,
        annotation.y,
        annotation.width,
        annotation.height
      );
    } else if (annotation.kind === 'ellipse') {
      ctx.strokeStyle = annotation.color;
      ctx.lineWidth = annotation.strokeWidth;
      ctx.beginPath();
      ctx.ellipse(
        annotation.x + annotation.width / 2,
        annotation.y + annotation.height / 2,
        Math.max(0, annotation.width / 2),
        Math.max(0, annotation.height / 2),
        0,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    } else if (annotation.kind === 'stroke') {
      drawBrushStroke(ctx, annotation);
    } else {
      ctx.fillStyle = annotation.color;
      ctx.font = `${annotation.fontSize}px system-ui, "SF Pro Text", "PingFang SC", sans-serif`;
      ctx.textBaseline = 'top';
      const lines = annotation.text.split('\n');
      lines.forEach((line, index) => {
        ctx.fillText(
          line,
          annotation.x,
          annotation.y + index * annotation.fontSize * TEXT_LINE_HEIGHT
        );
      });
      if (options.draggingId === annotation.id) {
        ctx.strokeStyle = annotation.color;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(
          annotation.x,
          annotation.y,
          annotation.width,
          textAnnotationHeight(annotation)
        );
      }
    }
    ctx.restore();
  }
}

export async function fileFromAnnotatedImage({
  src,
  naturalSize,
  annotations,
  fileName,
}: {
  src: string;
  naturalSize: Size;
  annotations: readonly Annotation[];
  fileName?: string;
}): Promise<File> {
  const image = await loadSourceImage(src);
  const width = Math.max(
    1,
    Math.round(naturalSize.width || image.naturalWidth)
  );
  const height = Math.max(
    1,
    Math.round(naturalSize.height || image.naturalHeight)
  );
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas is unavailable');
  }
  context.drawImage(image, 0, 0, width, height);
  drawAnnotations(context, annotations);
  const blob = await canvasToBlob(canvas);
  return new File([blob], markedImageFileName(fileName), {
    type: 'image/png',
  });
}

export function markedImageFileName(fileName?: string) {
  const base = (fileName ?? 'image').replace(/\.[^/.]+$/, '');
  const stem = base.trim() || 'image';
  return `${stem}-marked.png`;
}

function annotationContains(annotation: Annotation, point: Point) {
  if (annotation.kind === 'stroke') {
    const threshold = Math.max(8, annotation.size / 2 + 4);
    return annotation.points.some(
      (strokePoint) => distance(strokePoint, point) <= threshold
    );
  }
  if (annotation.kind === 'text') {
    return pointInRect(point, {
      x: annotation.x,
      y: annotation.y,
      width: annotation.width,
      height: textAnnotationHeight(annotation),
    });
  }
  if (annotation.kind === 'ellipse') {
    return pointInEllipse(point, annotation);
  }
  return pointInRect(point, annotation);
}

function pointInRect(
  point: Point,
  rect: { x: number; y: number; width: number; height: number }
) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function pointInEllipse(point: Point, ellipse: EllipseAnnotation) {
  const rx = ellipse.width / 2;
  const ry = ellipse.height / 2;
  if (rx <= 0 || ry <= 0) {
    return false;
  }
  const cx = ellipse.x + rx;
  const cy = ellipse.y + ry;
  const dx = (point.x - cx) / rx;
  const dy = (point.y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function drawBrushStroke(
  ctx: CanvasRenderingContext2D,
  annotation: BrushAnnotation
) {
  const [first, ...rest] = annotation.points;
  if (!first) {
    return;
  }
  ctx.globalAlpha = ANNOTATION_BRUSH_OPACITY;
  ctx.strokeStyle = annotation.color;
  ctx.fillStyle = annotation.color;
  ctx.lineWidth = annotation.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (rest.length === 0) {
    ctx.beginPath();
    ctx.ellipse(
      first.x,
      first.y,
      annotation.size / 2,
      annotation.size / 2,
      0,
      0,
      Math.PI * 2
    );
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (const point of rest) {
    ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
}

function clampPoint(
  point: Point,
  bounds?: Size,
  size: Size = { width: 0, height: 0 }
): Point {
  if (!bounds) {
    return point;
  }
  const minX = Math.min(0, bounds.width - 8);
  const minY = Math.min(0, bounds.height - 8);
  const maxX = Math.max(
    minX,
    bounds.width - Math.min(size.width, bounds.width)
  );
  const maxY = Math.max(
    minY,
    bounds.height - Math.min(size.height, bounds.height)
  );
  return {
    x: Math.min(maxX, Math.max(-Math.max(0, size.width - 8), point.x)),
    y: Math.min(maxY, Math.max(-Math.max(0, size.height - 8), point.y)),
  };
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

async function loadSourceImage(src: string): Promise<HTMLImageElement> {
  try {
    return await loadImageElement(src);
  } catch {
    const response = await fetch(src);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return loadImageElement(await blobToDataUrl(await response.blob()));
  }
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (typeof image.decode === 'function') {
        void image.decode().finally(() => resolve(image));
        return;
      }
      resolve(image);
    };
    image.onerror = () => reject(new Error('Failed to load image'));
    image.src = src;
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () =>
      reject(reader.error ?? new Error('Failed to read image'));
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error('Could not encode image'));
      }, 'image/png');
      return;
    }
    try {
      const dataUrl = canvas.toDataURL('image/png');
      resolve(dataUrlToBlob(dataUrl));
    } catch (error) {
      reject(error);
    }
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, body] = dataUrl.split(',');
  const bytes = Uint8Array.from(atob(body ?? ''), (char) => char.charCodeAt(0));
  const mime = /data:(.*?);/.exec(header ?? '')?.[1] ?? 'image/png';
  return new Blob([bytes], { type: mime });
}
