export const DEFAULT_PROJECT_RAIL_VISIBLE_PROJECTS = 6;
export const MAX_PROJECT_RAIL_VISIBLE_PROJECTS = 10;
const PROJECT_RAIL_ITEM_SIZE = 31;
const PROJECT_RAIL_ITEM_GAP = 6;
const PROJECT_RAIL_CHROME_HEIGHT = 51;

export function buildProjectRailOrderedIds(input: {
  openProjectIds: string[];
  currentProjectId?: string | null;
  projectSnapshotIds: string[];
  projectIds: string[];
}): string[] {
  return Array.from(
    new Set([
      ...input.openProjectIds,
      ...(input.currentProjectId ? [input.currentProjectId] : []),
      ...input.projectSnapshotIds,
      ...input.projectIds,
    ])
  );
}

export function capProjectRailVisibleCount(count: number): number {
  return Math.min(
    MAX_PROJECT_RAIL_VISIBLE_PROJECTS,
    Math.max(DEFAULT_PROJECT_RAIL_VISIBLE_PROJECTS, Math.max(0, count))
  );
}

export function projectRailPanelHeight(visibleSlotCount: number): number {
  const slots = Math.max(1, visibleSlotCount);
  return (
    PROJECT_RAIL_CHROME_HEIGHT +
    slots * PROJECT_RAIL_ITEM_SIZE +
    Math.max(0, slots - 1) * PROJECT_RAIL_ITEM_GAP
  );
}
