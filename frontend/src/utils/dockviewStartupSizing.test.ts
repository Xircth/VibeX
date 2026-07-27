import { describe, expect, it } from 'vitest';
import {
  defaultSessionPanelWidth,
  shouldDeferDefaultSizing,
  shouldRepairStartupDockWidth,
} from './dockviewStartupSizing';

describe('shouldDeferDefaultSizing', () => {
  it('makes only the initial session column 30% narrower', () => {
    // Previous default: 30% of the grid. New default: 70% of that (21%).
    expect(defaultSessionPanelWidth(2560, 400)).toBe(538);
    // Small windows retain the existing usability floor.
    expect(defaultSessionPanelWidth(1440, 400)).toBe(400);
  });

  it('does not settle during an early pause before the native window finishes restoring', () => {
    expect(shouldDeferDefaultSizing(30)).toBe(true);

    // The native window can remain at its launch size for a few frames before
    // restoration begins. Applying defaults here makes Dockview scale the
    // 200px file tree to roughly 300px when the window later expands.
    expect(shouldDeferDefaultSizing(29)).toBe(true);
    expect(shouldDeferDefaultSizing(0)).toBe(false);
  });

  it('repairs an inflated startup dock without rejecting normal sidebar widths', () => {
    expect(shouldRepairStartupDockWidth(576, 1440)).toBe(true);
    // A real persisted layout stored 453px at a 1360px grid. Dockview restored
    // it proportionally into a 1928px workspace, producing the 642px sidebar
    // seen when Workspace was opened after Kanban.
    expect(
      shouldRepairStartupDockWidth(Math.round(453 * (1928 / 1360)), 1928)
    ).toBe(true);
    expect(shouldRepairStartupDockWidth(300, 1440)).toBe(false);
    expect(shouldRepairStartupDockWidth(300, 760)).toBe(true);
    expect(shouldRepairStartupDockWidth(200, 760)).toBe(false);
    expect(shouldRepairStartupDockWidth(0, 1440)).toBe(false);
  });
});
