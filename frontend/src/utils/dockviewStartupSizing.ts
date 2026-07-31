/** Previous 620px seed reduced by exactly 30%. */
export const DEFAULT_SESSION_PANEL_WIDTH = 434;

/**
 * Initial session-column width only. The minimum is a usability floor, while
 * Dockview remains free to persist any later user drag verbatim.
 */
export function defaultSessionPanelWidth(
  _gridWidth: number,
  minimumWidth: number
): number {
  return Math.max(minimumWidth, DEFAULT_SESSION_PANEL_WIDTH);
}

interface WidthPreservingGroup {
  id: string;
  api: {
    width: number;
    isVisible: boolean;
    setSize(size: { width: number }): void;
  };
}

interface WidthPreservingDockview {
  layout(width: number, height: number, forceResize?: boolean): void;
}

const MAX_SIDE_WIDTH_SETTLE_PASSES = 12;
const SIDE_WIDTH_SETTLE_TOLERANCE = 0.5;

/**
 * Resize Dockview while keeping side groups pixel-stable.
 *
 * Dockview proportionally scales every grid column during `layout()`. That is
 * useful for flexible editor columns but turns a compact 200px file tree into
 * a much wider column during initial layout. Capturing the live group widths
 * immediately before the canvas resize also means any user-dragged width
 * becomes the value that is preserved, without imposing maximum constraints.
 */
export function layoutDockviewPreservingGroupWidths(
  api: WidthPreservingDockview,
  groups: readonly WidthPreservingGroup[],
  width: number,
  height: number,
  forceResize?: boolean
): void {
  const widths = groups.flatMap((group) => {
    const groupWidth = group.api.width;
    return group.api.isVisible && Number.isFinite(groupWidth) && groupWidth > 0
      ? [{ group, width: groupWidth }]
      : [];
  });

  api.layout(width, height, forceResize);

  // Dockview redistributes the delta from each setSize() across the other
  // columns, so restoring one side can nudge the other. Settle the two coupled
  // widths to sub-pixel precision; impossible sizes still stop at the bounded
  // pass count and remain clamped by Dockview's native minimum constraints.
  for (let attempt = 0; attempt < MAX_SIDE_WIDTH_SETTLE_PASSES; attempt += 1) {
    let isStable = true;
    for (const entry of widths.toReversed()) {
      if (
        entry.group.api.isVisible &&
        Math.abs(entry.group.api.width - entry.width) >
          SIDE_WIDTH_SETTLE_TOLERANCE
      ) {
        entry.group.api.setSize({ width: entry.width });
        isStable = false;
      }
    }
    if (isStable) break;
  }
}
