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
  element?: HTMLElement;
  api: {
    width: number;
    isVisible: boolean;
    setSize(size: { width: number }): void;
    setConstraints?(constraints: { minimumWidth: number }): void;
  };
}

interface WidthPreservingDockview {
  layout(width: number, height: number, forceResize?: boolean): void;
}

interface DockviewGroupWidthTarget {
  group: WidthPreservingGroup;
  width: number;
}

const MAX_SIDE_WIDTH_SETTLE_PASSES = 12;
const SIDE_WIDTH_SETTLE_TOLERANCE = 0.5;
const MIN_DOCK_WIDTH_WHILE_RESIZING = 120;
const MIN_WORKSPACE_WIDTH_WHILE_RESIZING = 320;

/**
 * Set coupled Dockview columns to their intended widths before the layout is
 * shown. Resizing one side redistributes space into the other, so a single
 * pass can leave the first column much wider than requested.
 */
export function settleDockviewGroupWidths(
  targets: readonly DockviewGroupWidthTarget[]
): void {
  for (let attempt = 0; attempt < MAX_SIDE_WIDTH_SETTLE_PASSES; attempt += 1) {
    let isStable = true;
    for (const target of targets.toReversed()) {
      if (
        target.group.api.isVisible &&
        Math.abs(target.group.api.width - target.width) >
          SIDE_WIDTH_SETTLE_TOLERANCE
      ) {
        target.group.api.setSize({ width: target.width });
        isStable = false;
      }
    }
    if (isStable) break;
  }
}

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

  const dockWidths = widths.filter(
    ({ group }) => group.element?.getAttribute('data-left-dock') === 'true'
  );
  const otherSideWidth = widths
    .filter(
      ({ group }) => group.element?.getAttribute('data-left-dock') !== 'true'
    )
    .reduce((total, item) => total + item.width, 0);
  const dockWidth = dockWidths.reduce((total, item) => total + item.width, 0);
  const dockBudget = Math.max(
    dockWidths.length * MIN_DOCK_WIDTH_WHILE_RESIZING,
    width - otherSideWidth - MIN_WORKSPACE_WIDTH_WHILE_RESIZING
  );
  const dockTargets =
    dockWidth > dockBudget
      ? dockWidths.map(({ group, width: previousWidth }) => {
          group.api.setConstraints?.({
            minimumWidth: MIN_DOCK_WIDTH_WHILE_RESIZING,
          });
          return {
            group,
            width: (previousWidth / dockWidth) * dockBudget,
          };
        })
      : [];

  // Dockview redistributes the delta from each setSize() across the other
  // columns, so restoring one side can nudge the other. Settle the two coupled
  // widths to sub-pixel precision; impossible sizes still stop at the bounded
  // pass count and remain clamped by Dockview's native minimum constraints.
  settleDockviewGroupWidths(
    dockTargets.length > 0
      ? [
          ...widths.filter(
            ({ group }) => !dockWidths.some((dock) => dock.group === group)
          ),
          ...dockTargets,
        ]
      : widths
  );
}
