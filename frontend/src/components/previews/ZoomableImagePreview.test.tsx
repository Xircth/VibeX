import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import {
  clearCurrentDraggedAnnotatedImage,
  getCurrentDraggedAnnotatedImage,
} from './imagePreviewDrag';
import { ZoomableImagePreview } from './ZoomableImagePreview';

const VIEWPORT = { width: 800, height: 600 };
const TALL_IMAGE = { width: 400, height: 2000 };

function mockImageNaturalSize(width: number, height: number, complete = true) {
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true,
    get: () => width,
  });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', {
    configurable: true,
    get: () => height,
  });
  Object.defineProperty(HTMLImageElement.prototype, 'complete', {
    configurable: true,
    get: () => complete,
  });
}

function installViewportObserver(size: { width: number; height: number }) {
  class MockResizeObserver {
    callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element) {
      Object.defineProperty(target, 'clientWidth', {
        configurable: true,
        value: size.width,
      });
      Object.defineProperty(target, 'clientHeight', {
        configurable: true,
        value: size.height,
      });
      target.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          right: size.width,
          bottom: size.height,
          width: size.width,
          height: size.height,
          x: 0,
          y: 0,
          toJSON() {
            return this;
          },
        }) as DOMRect;
      this.callback(
        [{ target } as ResizeObserverEntry],
        this as unknown as ResizeObserver
      );
    }

    unobserve() {}

    disconnect() {}
  }

  vi.stubGlobal('ResizeObserver', MockResizeObserver);
}

function stage() {
  return screen.getByTestId('image-preview-stage');
}

function viewport() {
  return screen.getByTestId('image-preview-viewport');
}

describe('ZoomableImagePreview', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    mockImageNaturalSize(TALL_IMAGE.width, TALL_IMAGE.height);
    installViewportObserver(VIEWPORT);
    clearCurrentDraggedAnnotatedImage();
  });

  afterEach(() => {
    clearCurrentDraggedAnnotatedImage();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('contains a tall image in the viewport instead of cropping it to full width', async () => {
    render(
      <ZoomableImagePreview src="asset://localhost/tall.png" alt="tall photo" />
    );

    const image = await screen.findByRole('img', { name: 'tall photo' });

    await waitFor(() => {
      expect(stage()).toHaveStyle({ width: '120px', height: '600px' });
    });
    expect(image.style.maxWidth).toBe('none');
    expect(image.style.maxHeight).toBe('none');
    expect(viewport()).toHaveClass('overflow-hidden');
  });

  it('localizes zoom and pan hints', async () => {
    const { unmount } = render(
      <ZoomableImagePreview src="asset://localhost/i18n.png" alt="photo" />
    );
    expect(screen.getByText('Wheel to zoom')).toBeInTheDocument();
    expect(screen.getByText('Drag to pan')).toBeInTheDocument();
    unmount();

    await i18n.changeLanguage('zh-CN');
    render(
      <ZoomableImagePreview src="asset://localhost/i18n.png" alt="photo" />
    );
    expect(screen.getByText('滚轮缩放')).toBeInTheDocument();
    expect(screen.getByText('拖动平移')).toBeInTheDocument();
  });

  it('zooms a cached image without waiting for another load event', async () => {
    render(
      <ZoomableImagePreview src="asset://localhost/cached.png" alt="cached" />
    );

    await waitFor(() => {
      expect(stage()).toHaveStyle({ width: '120px' });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));

    await waitFor(() => {
      expect(stage().style.transform).toContain('scale(1.25)');
    });
    expect(viewport()).toHaveClass('cursor-grab');
  });

  it('fits, pans, and resets from the toolbar', async () => {
    render(
      <ZoomableImagePreview src="asset://localhost/toolbar.png" alt="toolbar" />
    );

    await waitFor(() => {
      expect(stage()).toHaveStyle({ width: '120px' });
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'View image at actual size' })
    );
    await waitFor(() => {
      expect(stage().style.transform).toContain(`scale(${1 / 0.3})`);
    });

    fireEvent.pointerDown(viewport(), {
      pointerId: 1,
      clientX: 400,
      clientY: 300,
    });
    fireEvent.pointerMove(viewport(), {
      pointerId: 1,
      clientX: 400,
      clientY: 120,
    });
    await waitFor(() => {
      expect(stage().style.transform).toContain('translate(0px, -180px)');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Fit image to view' }));
    await waitFor(() => {
      expect(stage().style.transform).toContain('scale(1)');
      expect(stage().style.transform).toContain('translate(0px, 0px)');
    });
  });

  it('captures wheel events so zoom is not stolen by page scroll', () => {
    const addEventListener = vi.spyOn(
      HTMLElement.prototype,
      'addEventListener'
    );
    render(
      <ZoomableImagePreview src="asset://localhost/wheel.png" alt="wheel" />
    );

    expect(
      addEventListener.mock.calls.some(
        (call) =>
          call[0] === 'wheel' &&
          typeof call[1] === 'function' &&
          Boolean(
            call[2] && (call[2] as AddEventListenerOptions).passive === false
          )
      )
    ).toBe(true);
    addEventListener.mockRestore();
  });

  it('draws a rectangle mark in image space', async () => {
    render(
      <ZoomableImagePreview src="asset://localhost/mark.png" alt="mark" />
    );
    await waitFor(() => {
      expect(stage()).toHaveStyle({ width: '120px' });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));
    fireEvent.pointerDown(viewport(), {
      pointerId: 2,
      clientX: 400,
      clientY: 100,
    });
    fireEvent.pointerMove(viewport(), {
      pointerId: 2,
      clientX: 460,
      clientY: 400,
    });
    fireEvent.pointerUp(viewport(), { pointerId: 2 });

    const rect = await waitFor(() => {
      const node = screen
        .getByTestId('image-preview-annotation-layer')
        .querySelector('rect');
      expect(node).not.toBeNull();
      return node as SVGRectElement;
    });
    expect(Number(rect.getAttribute('width'))).toBeGreaterThan(4);
    expect(Number(rect.getAttribute('height'))).toBeGreaterThan(4);
  });

  it('shows a text-box border only while dragging it', async () => {
    render(
      <ZoomableImagePreview src="asset://localhost/text.png" alt="text" />
    );
    await waitFor(() => {
      expect(stage()).toHaveStyle({ width: '120px' });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.pointerDown(viewport(), {
      pointerId: 3,
      clientX: 400,
      clientY: 200,
    });
    fireEvent.pointerUp(viewport(), { pointerId: 3 });

    const field = await screen.findByPlaceholderText('Text');
    fireEvent.change(field, { target: { value: 'note' } });
    fireEvent.blur(field);

    expect(screen.getByText('note').parentElement?.className).not.toMatch(
      /ring-1/
    );

    fireEvent.pointerDown(viewport(), {
      pointerId: 4,
      clientX: 400,
      clientY: 200,
    });
    fireEvent.pointerMove(viewport(), {
      pointerId: 4,
      clientX: 430,
      clientY: 230,
    });
    expect(screen.getByText('note').parentElement?.className).toMatch(/ring-1/);

    fireEvent.pointerUp(viewport(), { pointerId: 4 });
    expect(screen.getByText('note').parentElement?.className).not.toMatch(
      /ring-1/
    );
  });

  it('lifts an in-memory marked image after a long press without using the original file', async () => {
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

    render(
      <ZoomableImagePreview src="asset://localhost/shot.png" alt="shot.png" />
    );
    await waitFor(() => {
      expect(stage()).toHaveStyle({ width: '120px' });
    });

    fireEvent.pointerDown(viewport(), {
      pointerId: 5,
      clientX: 400,
      clientY: 300,
    });

    await waitFor(() => {
      expect(getCurrentDraggedAnnotatedImage()?.name).toBe('shot-marked.png');
    });
    expect(getCurrentDraggedAnnotatedImage()?.type).toBe('image/png');
  });
});
