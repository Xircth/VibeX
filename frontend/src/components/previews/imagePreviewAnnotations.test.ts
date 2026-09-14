import { describe, expect, it, vi } from 'vitest';
import {
  ANNOTATION_BRUSH_OPACITY,
  annotationHasArea,
  applyAnnotationStyle,
  createBrushAnnotation,
  createRectAnnotation,
  createTextAnnotation,
  drawAnnotations,
  fileFromAnnotatedImage,
  hitTestAnnotation,
  moveAnnotation,
  rectFromPoints,
  viewportPointToImage,
  type Annotation,
} from './imagePreviewAnnotations';

const NATURAL = { width: 400, height: 2000 };
const VIEWPORT = { width: 800, height: 600 };
const FITTED = { width: 120, height: 600 };

describe('image preview annotations', () => {
  it('normalizes a dragged rectangle so origin is top-left', () => {
    expect(rectFromPoints({ x: 80, y: 40 }, { x: 20, y: 10 })).toEqual({
      x: 20,
      y: 10,
      width: 60,
      height: 30,
    });
  });

  it('maps a viewport point onto the natural image', () => {
    expect(
      viewportPointToImage(
        { x: 400, y: 100 },
        { left: 0, top: 0 },
        VIEWPORT,
        FITTED,
        1,
        { x: 0, y: 0 },
        NATURAL
      )
    ).toEqual({ x: 200, y: 1000 / 3 });
  });

  it('moves a rectangle by a delta without writing the source object', () => {
    const rect = createRectAnnotation({
      id: 'box-1',
      start: { x: 40, y: 80 },
      end: { x: 120, y: 160 },
      color: '#ff3b30',
      strokeWidth: 4,
    });
    const moved = moveAnnotation(rect, 12, -8, NATURAL);
    expect(moved).toMatchObject({ x: 52, y: 72, width: 80, height: 80 });
    expect(rect).toMatchObject({ x: 40, y: 80 });
  });

  it('hit-tests rectangles and text boxes', () => {
    const rect = createRectAnnotation({
      id: 'box-1',
      start: { x: 40, y: 80 },
      end: { x: 120, y: 160 },
      color: '#ff3b30',
      strokeWidth: 4,
    });
    const text = createTextAnnotation({
      id: 'text-1',
      point: { x: 200, y: 300 },
      color: '#ffffff',
      fontSize: 28,
      text: 'note',
    });

    expect(hitTestAnnotation([text, rect], { x: 50, y: 90 })).toBe('box-1');
    expect(hitTestAnnotation([text, rect], { x: 210, y: 310 })).toBe('text-1');
    expect(hitTestAnnotation([text, rect], { x: 10, y: 10 })).toBeNull();
  });

  it('keeps a tiny drag from becoming a mark', () => {
    const rect = createRectAnnotation({
      id: 'box-1',
      start: { x: 40, y: 80 },
      end: { x: 42, y: 81 },
      color: '#ff3b30',
      strokeWidth: 4,
    });
    expect(annotationHasArea(rect)).toBe(false);
    expect(
      annotationHasArea(
        createBrushAnnotation({
          id: 'stroke-1',
          point: { x: 10, y: 10 },
          color: '#ff3b30',
          size: 16,
        })
      )
    ).toBe(true);
  });

  it('updates the selected mark color and thickness', () => {
    const rect = createRectAnnotation({
      id: 'box-1',
      start: { x: 0, y: 0 },
      end: { x: 40, y: 40 },
      color: '#ff3b30',
      strokeWidth: 4,
    });
    expect(
      applyAnnotationStyle(rect, { color: '#34c759', strokeWidth: 8 })
    ).toMatchObject({
      color: '#34c759',
      strokeWidth: 8,
    });
  });

  it('paints annotations onto a canvas in image space', () => {
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      strokeRect: vi.fn(),
      ellipse: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      fillText: vi.fn(),
      setLineDash: vi.fn(),
      drawImage: vi.fn(),
      measureText: vi.fn(() => ({ width: 40 })),
    } as unknown as CanvasRenderingContext2D;

    const annotations: Annotation[] = [
      createRectAnnotation({
        id: 'box-1',
        start: { x: 10, y: 20 },
        end: { x: 50, y: 80 },
        color: '#ff3b30',
        strokeWidth: 4,
      }),
      createBrushAnnotation({
        id: 'stroke-1',
        point: { x: 12, y: 18 },
        color: '#007aff',
        size: 16,
      }),
      createTextAnnotation({
        id: 'text-1',
        point: { x: 80, y: 90 },
        color: '#ffffff',
        fontSize: 24,
        text: 'hello',
      }),
    ];

    drawAnnotations(ctx, annotations);

    expect(ctx.strokeRect).toHaveBeenCalledWith(10, 20, 40, 60);
    expect(ctx.fillText).toHaveBeenCalledWith('hello', 80, expect.any(Number));
    expect(ANNOTATION_BRUSH_OPACITY).toBeGreaterThan(0);
    expect(ANNOTATION_BRUSH_OPACITY).toBeLessThan(1);
  });

  it('exports a new png file instead of rewriting the source image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(['src'], { type: 'image/png' }),
      }))
    );
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 4;
      naturalHeight = 4;
      width = 4;
      height = 4;
      decode = async () => undefined;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', FakeImage);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      strokeRect: vi.fn(),
      ellipse: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      fillText: vi.fn(),
      setLineDash: vi.fn(),
      measureText: vi.fn(() => ({ width: 10 })),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      function toBlob(this: HTMLCanvasElement, callback) {
        callback(new Blob(['marked'], { type: 'image/png' }));
      }
    );

    const file = await fileFromAnnotatedImage({
      src: 'asset://localhost/shot.png',
      naturalSize: { width: 4, height: 4 },
      annotations: [
        createRectAnnotation({
          id: 'box-1',
          start: { x: 0, y: 0 },
          end: { x: 4, y: 4 },
          color: '#ff3b30',
          strokeWidth: 2,
        }),
      ],
      fileName: 'shot.png',
    });

    expect(file.name).toBe('shot-marked.png');
    expect(file.type).toBe('image/png');
    expect(await file.text()).toBe('marked');
    vi.unstubAllGlobals();
  });
});
