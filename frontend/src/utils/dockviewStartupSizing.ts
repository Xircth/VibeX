/**
 * Whether default Dockview sizes should wait for another animation frame.
 *
 * The current implementation mirrors the workspace startup logic so its
 * delayed native-window resize race can be covered by a focused regression
 * test before changing that behaviour.
 */
export function shouldDeferDefaultSizing(retries: number): boolean {
  // A native window may sit at its launch size for several identical frames
  // before restoration begins. Spend the full frame budget so the defaults
  // are applied against the final canvas size, not an early local plateau.
  return retries > 0;
}

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

const STARTUP_DOCK_MAX_WIDTH = 320;
const STARTUP_DOCK_MAX_RATIO = 0.28;
const STARTUP_DOCK_MIN_WIDTH = 200;

/**
 * Detect a left dock that was proportionally inflated while the native window
 * was restoring. This is intentionally a startup-only guard: after the app is
 * ready, users remain free to drag the dock wider than this comfort bound.
 */
export function shouldRepairStartupDockWidth(
  dockWidth: number,
  gridWidth: number
): boolean {
  if (
    !Number.isFinite(dockWidth) ||
    !Number.isFinite(gridWidth) ||
    dockWidth <= 0 ||
    gridWidth <= 0
  ) {
    return false;
  }

  const comfortableWidth = Math.max(
    STARTUP_DOCK_MIN_WIDTH,
    Math.min(STARTUP_DOCK_MAX_WIDTH, gridWidth * STARTUP_DOCK_MAX_RATIO)
  );

  return dockWidth > comfortableWidth + 1;
}
