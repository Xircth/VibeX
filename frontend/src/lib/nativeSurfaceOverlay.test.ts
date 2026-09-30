import { describe, expect, it } from 'vitest';
import {
  nativeSurfaceNeedsFreezeFrame,
  overlayCoversSurface,
} from './nativeSurfaceOverlay';

const surface = { x: 12, y: 48, width: 800, height: 600 };

describe('overlayCoversSurface', () => {
  it('ignores popovers that stay in chrome above the page', () => {
    expect(
      overlayCoversSurface(surface, [{ x: 700, y: 12, width: 80, height: 28 }])
    ).toBe(false);
  });

  it('detects a menu that drops onto the page', () => {
    expect(
      overlayCoversSurface(surface, [
        { x: 620, y: 40, width: 180, height: 220 },
      ])
    ).toBe(true);
  });
});

describe('nativeSurfaceNeedsFreezeFrame', () => {
  it('skips freeze when chrome fully covers the native page', () => {
    expect(nativeSurfaceNeedsFreezeFrame({ hide: true })).toBe(false);
  });

  it('freezes when only a popover rectangle covers the page', () => {
    expect(nativeSurfaceNeedsFreezeFrame({ hide: false })).toBe(true);
  });
});
