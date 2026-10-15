import { describe, expect, it } from 'vitest';
import { nextSurfaceActive } from './surfaceActivity';

describe('nextSurfaceActive', () => {
  it('keeps a visible conversation active while the window is hidden', () => {
    expect(
      nextSurfaceActive({
        active: true,
        intersecting: false,
        visibilityState: 'hidden',
        seenVisible: true,
      })
    ).toEqual({ active: true, seenVisible: true });
  });

  it('drops an off-screen surface after it has been seen', () => {
    expect(
      nextSurfaceActive({
        active: true,
        intersecting: false,
        visibilityState: 'visible',
        seenVisible: true,
      })
    ).toEqual({ active: false, seenVisible: true });
  });

  it('ignores the first miss before the surface has been laid out', () => {
    expect(
      nextSurfaceActive({
        active: true,
        intersecting: false,
        visibilityState: 'visible',
        seenVisible: false,
      })
    ).toEqual({ active: true, seenVisible: false });
  });

  it('marks an intersecting visible surface active', () => {
    expect(
      nextSurfaceActive({
        active: false,
        intersecting: true,
        visibilityState: 'visible',
        seenVisible: false,
      })
    ).toEqual({ active: true, seenVisible: true });
  });
});
