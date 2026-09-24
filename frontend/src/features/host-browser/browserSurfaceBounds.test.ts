import { describe, expect, it } from 'vitest';
import { snapBrowserSurfaceRect } from './browserSurfaceBounds';

describe('snapBrowserSurfaceRect', () => {
  it('keeps integer CSS pixels unchanged', () => {
    expect(
      snapBrowserSurfaceRect(
        { left: 200, top: 80, right: 800, bottom: 500 },
        1
      )
    ).toEqual({ x: 200, y: 80, width: 600, height: 420 });
  });

  it('sizes from snapped edges so the native view cannot outgrow the host', () => {
    const scale = 1.25;
    const snapped = snapBrowserSurfaceRect(
      { left: 100.4, top: 40.4, right: 900.8, bottom: 640.8 },
      scale
    );
    const leftPx = Math.round(snapped.x * scale);
    const widthPx = Math.round(snapped.width * scale);
    const rightPx = Math.round(900.8 * scale);
    expect(leftPx + widthPx).toBe(rightPx);
  });
});
