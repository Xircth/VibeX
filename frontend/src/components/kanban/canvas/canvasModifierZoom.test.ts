import { describe, expect, it } from 'vitest';
import {
  isCanvasModifierZoomWheel,
  nextCanvasModifierZoom,
} from './canvasModifierZoom';

const viewport = { x: 100, y: 50, zoom: 1 };

describe('canvas modifier zoom', () => {
  it('treats ctrl and meta wheel as zoom and leaves a plain wheel alone', () => {
    expect(isCanvasModifierZoomWheel({ ctrlKey: true, metaKey: false })).toBe(
      true
    );
    expect(isCanvasModifierZoomWheel({ ctrlKey: false, metaKey: true })).toBe(
      true
    );
    expect(isCanvasModifierZoomWheel({ ctrlKey: false, metaKey: false })).toBe(
      false
    );
  });

  it('zooms toward the pointer and keeps that canvas point under the cursor', () => {
    const next = nextCanvasModifierZoom({
      viewport,
      pointerX: 200,
      pointerY: 80,
      deltaY: -100,
      deltaMode: 0,
      pinchBoost: false,
      minZoom: 0.1,
      maxZoom: 2,
    });
    expect(next.zoom).toBeGreaterThan(1);
    const flowX = (200 - viewport.x) / viewport.zoom;
    const flowY = (80 - viewport.y) / viewport.zoom;
    expect(flowX * next.zoom + next.x).toBeCloseTo(200);
    expect(flowY * next.zoom + next.y).toBeCloseTo(80);
  });

  it('zooms out on a positive wheel delta and stops at the limits', () => {
    const out = nextCanvasModifierZoom({
      viewport,
      pointerX: 0,
      pointerY: 0,
      deltaY: 40,
      deltaMode: 0,
      pinchBoost: false,
      minZoom: 0.1,
      maxZoom: 2,
    });
    expect(out.zoom).toBeLessThan(1);
    const capped = nextCanvasModifierZoom({
      viewport: { x: 0, y: 0, zoom: 2 },
      pointerX: 10,
      pointerY: 10,
      deltaY: -400,
      deltaMode: 0,
      pinchBoost: false,
      minZoom: 0.1,
      maxZoom: 2,
    });
    expect(capped).toEqual({ x: 0, y: 0, zoom: 2 });
  });

  it('applies the macOS pinch boost', () => {
    const plain = nextCanvasModifierZoom({
      viewport,
      pointerX: 0,
      pointerY: 0,
      deltaY: -20,
      deltaMode: 0,
      pinchBoost: false,
      minZoom: 0.1,
      maxZoom: 8,
    });
    const pinch = nextCanvasModifierZoom({
      viewport,
      pointerX: 0,
      pointerY: 0,
      deltaY: -20,
      deltaMode: 0,
      pinchBoost: true,
      minZoom: 0.1,
      maxZoom: 8,
    });
    expect(pinch.zoom).toBeGreaterThan(plain.zoom);
  });
});
