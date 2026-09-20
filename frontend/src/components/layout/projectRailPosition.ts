export type ProjectRailPosition = {
  x: number;
  y: number;
};

export const PROJECT_RAIL_WIDTH = 220;
export const PROJECT_RAIL_EDGE_MARGIN = 8;
export const PROJECT_RAIL_DEFAULT_LEFT = 12;

export function clampProjectRailPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = PROJECT_RAIL_EDGE_MARGIN
): ProjectRailPosition {
  const maxX = Math.max(margin, viewportWidth - width - margin);
  const maxY = Math.max(margin, viewportHeight - height - margin);

  return {
    x: Math.min(Math.max(margin, x), maxX),
    y: Math.min(Math.max(margin, y), maxY),
  };
}

export function defaultProjectRailPosition(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number
): ProjectRailPosition {
  const safeWidth =
    viewportWidth >= width + PROJECT_RAIL_EDGE_MARGIN * 2
      ? viewportWidth
      : 1280;
  const safeHeight =
    viewportHeight >= height + PROJECT_RAIL_EDGE_MARGIN * 2
      ? viewportHeight
      : 800;

  return clampProjectRailPosition(
    PROJECT_RAIL_DEFAULT_LEFT,
    (safeHeight - height) / 2,
    width,
    height,
    safeWidth,
    safeHeight
  );
}

export function readViewportSize(): { width: number; height: number } {
  if (typeof window === 'undefined') {
    return { width: 1280, height: 800 };
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}
