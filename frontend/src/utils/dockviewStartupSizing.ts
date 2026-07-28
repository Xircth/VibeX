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
