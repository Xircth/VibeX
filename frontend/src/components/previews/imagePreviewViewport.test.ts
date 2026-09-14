import { describe, expect, it } from 'vitest';
import {
  actualSizeScale,
  canPanImage,
  clampOffset,
  getContainedSize,
  offsetAfterScale,
} from './imagePreviewViewport';

describe('getContainedSize', () => {
  it('fits a tall image to the viewport height instead of cropping it to full width', () => {
    expect(
      getContainedSize(
        { width: 400, height: 2000 },
        { width: 800, height: 600 }
      )
    ).toEqual({
      width: 120,
      height: 600,
      fitRatio: 0.3,
    });
  });

  it('fits a wide image to the viewport width without overflowing vertically', () => {
    expect(
      getContainedSize(
        { width: 2000, height: 400 },
        { width: 800, height: 600 }
      )
    ).toEqual({
      width: 800,
      height: 160,
      fitRatio: 0.4,
    });
  });

  it('does not upscale an image that already fits', () => {
    expect(
      getContainedSize({ width: 320, height: 240 }, { width: 800, height: 600 })
    ).toEqual({
      width: 320,
      height: 240,
      fitRatio: 1,
    });
  });
});

describe('image pan and zoom math', () => {
  const viewport = { width: 800, height: 600 };
  const fitted = { width: 120, height: 600 };

  it('only allows panning once the scaled image exceeds the viewport', () => {
    expect(canPanImage(1, fitted, viewport)).toBe(false);
    expect(canPanImage(2, fitted, viewport)).toBe(true);
  });

  it('keeps 1:1 scale at the inverse of the fit ratio', () => {
    expect(actualSizeScale(0.3)).toBeCloseTo(1 / 0.3);
  });

  it('clamps pan so the image cannot be dragged out of view', () => {
    expect(clampOffset({ x: 400, y: -400 }, 2, fitted, viewport)).toEqual({
      x: 0,
      y: -300,
    });
  });

  it('zooms toward the pointer anchor', () => {
    expect(
      offsetAfterScale({
        currentOffset: { x: 0, y: 0 },
        currentScale: 1,
        nextScale: 2,
        anchor: { x: 40, y: -80 },
        fitted,
        viewport,
      })
    ).toEqual({ x: 0, y: 80 });
  });
});
