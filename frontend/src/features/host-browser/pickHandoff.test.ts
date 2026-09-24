import { describe, expect, it } from 'vitest';

import { cropRectToImage } from './pickHandoff';

describe('cropRectToImage', () => {
  it('maps CSS element boxes onto the captured bitmap', () => {
    expect(
      cropRectToImage(
        { x: 100, y: 50, width: 200, height: 80 },
        { width: 800, height: 600 },
        1600,
        1200
      )
    ).toEqual({ sx: 200, sy: 100, sw: 400, sh: 160 });
  });

  it('clamps a box that runs off the viewport', () => {
    expect(
      cropRectToImage(
        { x: 700, y: 500, width: 200, height: 200 },
        { width: 800, height: 600 },
        800,
        600
      )
    ).toEqual({ sx: 700, sy: 500, sw: 100, sh: 100 });
  });
});
