export const DEFAULT_PROJECT_RAIL_VISIBLE_PROJECTS = 6;
export const MAX_PROJECT_RAIL_VISIBLE_PROJECTS = 10;
export const BOTTOM_STATUS_PROJECT_LIMIT = 6;
const PROJECT_RAIL_ITEM_SIZE = 31;
const PROJECT_RAIL_ITEM_GAP = 6;
const PROJECT_RAIL_CHROME_HEIGHT = 51;

export function selectBottomStatusProjectIds(input: {
  openProjectIds: string[];
  currentProjectId?: string | null;
  existingProjectIds: Iterable<string>;
  limit?: number;
}): string[] {
  const existing = new Set(input.existingProjectIds);
  const limit = input.limit ?? BOTTOM_STATUS_PROJECT_LIMIT;
  return Array.from(
    new Set([
      ...(input.currentProjectId ? [input.currentProjectId] : []),
      ...input.openProjectIds,
    ])
  )
    .filter((projectId) => existing.has(projectId))
    .slice(0, limit);
}

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

function compareRailSiblings<
  T extends { id: string; name: string; is_home?: boolean },
>(left: T, right: T): number {
  if (Boolean(left.is_home) !== Boolean(right.is_home)) {
    return left.is_home ? -1 : 1;
  }
  const byName = left.name.localeCompare(right.name, undefined, {
    sensitivity: 'base',
  });
  if (byName !== 0) {
    return byName;
  }
  return left.id.localeCompare(right.id);
}

export function buildProjectRailTree<
  T extends {
    id: string;
    name: string;
    parent_project_id?: string | null;
    is_home?: boolean;
  },
>(projects: T[]): Array<T & { depth: number }> {
  const byParent = new Map<string | null, T[]>();
  for (const project of projects) {
    const parent = project.is_home ? null : (project.parent_project_id ?? null);
    const list = byParent.get(parent) ?? [];
    list.push(project);
    byParent.set(parent, list);
  }
  for (const siblings of byParent.values()) {
    siblings.sort(compareRailSiblings);
  }

  const nested: Array<T & { depth: number }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const project of byParent.get(parentId) ?? []) {
      nested.push({ ...project, depth });
      walk(project.id, depth + 1);
    }
  };
  walk(null, 0);

  const seen = new Set(nested.map((project) => project.id));
  for (const project of projects) {
    if (!seen.has(project.id)) {
      nested.push({ ...project, depth: 0 });
    }
  }
  return nested;
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
