export interface ProjectRailProjectLike {
  id: string;
}

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
