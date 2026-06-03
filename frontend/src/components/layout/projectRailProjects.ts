export interface ProjectRailProjectLike {
  id: string;
}

export const MAX_PROJECT_RAIL_VISIBLE_PROJECTS = 8;

export function mergeProjectsById<T extends ProjectRailProjectLike>(
  liveProjects: T[],
  fallbackProjects: T[]
): T[] {
  const mergedProjects: T[] = [];
  const seenProjectIds = new Set<string>();

  for (const project of [...liveProjects, ...fallbackProjects]) {
    if (seenProjectIds.has(project.id)) {
      continue;
    }

    seenProjectIds.add(project.id);
    mergedProjects.push(project);
  }

  return mergedProjects;
}

export function buildProjectRailOrderedIds(input: {
  openProjectIds: string[];
  currentProjectId?: string | null;
  projectSnapshotIds: string[];
  projectIds: string[];
  preferProjectListOrder?: boolean;
}): string[] {
  if (input.preferProjectListOrder) {
    return Array.from(
      new Set([...input.projectIds, ...input.projectSnapshotIds, ...input.openProjectIds])
    );
  }

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
    Math.max(0, count),
    MAX_PROJECT_RAIL_VISIBLE_PROJECTS
  );
}
