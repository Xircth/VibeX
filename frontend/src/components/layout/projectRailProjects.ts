export const MAX_PROJECT_RAIL_VISIBLE_PROJECTS = 8;

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
  return Math.min(Math.max(0, count), MAX_PROJECT_RAIL_VISIBLE_PROJECTS);
}
