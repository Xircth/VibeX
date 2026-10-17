const TERMINAL_HOST_PADDING_X = 16;
const TERMINAL_HOST_PADDING_Y = 4;
const TERMINAL_HOST_TRACK_TOLERANCE = 24;

export interface TerminalFitMeasurements {
  containerWidth: number;
  containerHeight: number;
  panelWidth: number;
  panelHeight: number;
  contentWidth: number;
  contentHeight: number;
  groupWidth: number;
}

export interface TerminalFitBox {
  width: number;
  height: number;
}

/**
 * FitAddon reads the xterm parent's computed box. That parent can stay
 * shrink-wrapped to the first grid while the dockview group grows, so a later
 * fit() keeps the old column count. When the host no longer tracks the panel,
 * size the grid from the panel and group instead.
 */
export function resolveTerminalFitBox(
  input: TerminalFitMeasurements
): TerminalFitBox {
  const outerWidth = Math.max(
    input.panelWidth,
    input.contentWidth,
    input.groupWidth
  );
  const outerHeight = Math.max(input.panelHeight, input.contentHeight);
  const widthTracks =
    outerWidth <= 0 ||
    Math.abs(input.containerWidth - outerWidth) <=
      TERMINAL_HOST_TRACK_TOLERANCE;
  const heightTracks =
    outerHeight <= 0 ||
    Math.abs(input.containerHeight - outerHeight) <=
      TERMINAL_HOST_TRACK_TOLERANCE;

  return {
    width: widthTracks
      ? input.containerWidth
      : Math.max(0, outerWidth - TERMINAL_HOST_PADDING_X),
    height: heightTracks
      ? input.containerHeight
      : Math.max(0, outerHeight - TERMINAL_HOST_PADDING_Y),
  };
}

export function terminalGridForBox(
  box: TerminalFitBox,
  cell: { width: number; height: number }
): { cols: number; rows: number } | null {
  if (!(cell.width > 0) || !(cell.height > 0)) return null;
  if (!(box.width > 0) || !(box.height > 0)) return null;
  return {
    cols: Math.max(2, Math.floor(box.width / cell.width)),
    rows: Math.max(1, Math.floor(box.height / cell.height)),
  };
}
