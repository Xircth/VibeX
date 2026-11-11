import { describe, expect, it } from 'vitest';

import {
  clampProjectRailPosition,
  defaultProjectRailPosition,
  PROJECT_RAIL_BOTTOM_OFFSET,
  PROJECT_RAIL_DEFAULT_LEFT,
  PROJECT_RAIL_EDGE_MARGIN,
  projectRailHoverPopoverPosition,
} from './projectRailPosition';

describe('clampProjectRailPosition', () => {
  it('keeps a position inside the window', () => {
    expect(clampProjectRailPosition(40, 80, 220, 280, 1280, 800)).toEqual({
      x: 40,
      y: 80,
    });
  });

  it('does not let the rail leave the left or top edge', () => {
    expect(clampProjectRailPosition(-40, -20, 220, 280, 1280, 800)).toEqual({
      x: PROJECT_RAIL_EDGE_MARGIN,
      y: PROJECT_RAIL_EDGE_MARGIN,
    });
  });

  it('does not let the rail leave the right or bottom edge', () => {
    expect(clampProjectRailPosition(2000, 2000, 220, 280, 1280, 800)).toEqual({
      x: 1280 - 220 - PROJECT_RAIL_EDGE_MARGIN,
      y: 800 - 280 - PROJECT_RAIL_EDGE_MARGIN,
    });
  });

  it('does not clamp y to the top margin when the viewport is not measured yet', () => {
    expect(clampProjectRailPosition(12, 260, 220, 280, 0, 0)).toEqual({
      x: 12,
      y: 260,
    });
  });
});

describe('defaultProjectRailPosition', () => {
  it('anchors the selector menu at the bottom-left above the status bar', () => {
    expect(defaultProjectRailPosition(220, 280, 1280, 800)).toEqual({
      x: PROJECT_RAIL_DEFAULT_LEFT,
      y: 800 - 280 - PROJECT_RAIL_BOTTOM_OFFSET,
    });
  });

  it('does not pin the rail to the origin when the viewport is not ready', () => {
    expect(defaultProjectRailPosition(220, 280, 0, 0)).toEqual({
      x: PROJECT_RAIL_DEFAULT_LEFT,
      y: 800 - 280 - PROJECT_RAIL_BOTTOM_OFFSET,
    });
  });
});

describe('projectRailHoverPopoverPosition', () => {
  it('places the popover to the right of the rail without overlapping it', () => {
    expect(
      projectRailHoverPopoverPosition(
        { top: 120, bottom: 150, left: 12, right: 232 },
        { left: 12, right: 232 },
        { width: 1280, height: 800 }
      )
    ).toEqual({ top: 120, left: 240 });
  });

  it('places the popover to the left when the rail is near the right edge', () => {
    expect(
      projectRailHoverPopoverPosition(
        { top: 120, bottom: 150, left: 1000, right: 1220 },
        { left: 1000, right: 1220 },
        { width: 1280, height: 800 }
      ).left
    ).toBe(1000 - 288 - 8);
  });
});
