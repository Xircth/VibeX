import type { DockviewApi, IDockviewGroupPanel } from 'dockview-core';
import { EDITOR_GROUP_PREFIX, GROUP_IDS } from '@/stores/useLayoutStore';

export type DockviewGroupZoneRole = 'left' | 'editor' | 'session' | 'bottom';

const groupZoneRoles = new WeakMap<object, DockviewGroupZoneRole>();

const LEFT_GROUP_ID_PREFIX = `${GROUP_IDS.LEFT}-`;
const RIGHT_GROUP_ID_PREFIX = `${GROUP_IDS.RIGHT}-`;

export function setDockviewGroupRole(
  group: object | null | undefined,
  role: DockviewGroupZoneRole
): void {
  if (!group || typeof group !== 'object') return;
  groupZoneRoles.set(group, role);
}

export function getDockviewGroupRole(
  group: object | null | undefined
): DockviewGroupZoneRole | null {
  if (!group || typeof group !== 'object') return null;
  return groupZoneRoles.get(group) ?? null;
}

function inferCanonicalRoleFromGroupId(
  groupId: string
): DockviewGroupZoneRole | null {
  if (groupId === GROUP_IDS.LEFT || groupId.startsWith(LEFT_GROUP_ID_PREFIX)) {
    return 'left';
  }
  if (
    groupId === GROUP_IDS.RIGHT ||
    groupId.startsWith(RIGHT_GROUP_ID_PREFIX)
  ) {
    return 'session';
  }
  if (groupId === GROUP_IDS.BOTTOM) {
    return 'bottom';
  }
  if (groupId.startsWith(EDITOR_GROUP_PREFIX)) {
    return 'editor';
  }
  return null;
}

interface InternalGroupViewLike {
  id?: string;
  model?: { id?: string };
  api?: { id?: string };
}

interface InternalGridNodeLike {
  id?: string;
  children?: unknown[];
  view?: InternalGroupViewLike;
}

function syncInternalGroupViewId(
  view: InternalGroupViewLike | undefined
): void {
  if (!view || typeof view.id !== 'string') return;
  const actualId = view.id;

  try {
    if (
      view.model &&
      typeof view.model.id === 'string' &&
      view.model.id !== actualId
    ) {
      view.model.id = actualId;
    }
  } catch {
    // Ignore read-only model.id in future dockview-core versions.
  }

  try {
    if (
      view.api &&
      typeof view.api.id === 'string' &&
      view.api.id !== actualId
    ) {
      (view.api as { id: string }).id = actualId;
    }
  } catch {
    // Ignore read-only api.id in future dockview-core versions.
  }
}

function syncGridviewLeafNodeIds(root: unknown): void {
  if (!root || typeof root !== 'object') return;
  const visited = new Set<object>();
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || visited.has(current)) {
      continue;
    }
    visited.add(current);

    const node = current as InternalGridNodeLike;
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        stack.push(child);
      }
      continue;
    }

    const leafView = node.view;
    if (leafView && typeof leafView.id === 'string') {
      syncInternalGroupViewId(leafView);
      try {
        if (typeof node.id === 'string' && node.id !== leafView.id) {
          node.id = leafView.id;
        }
      } catch {
        // Ignore read-only leaf node id properties.
      }
    }
  }
}

/**
 * Re-key dockview's internal group registry and grid leaf references after
 * group ids were renamed. Guarded so private Dockview field changes never throw.
 */
export function syncDockviewGroupRegistry(api: DockviewApi): void {
  try {
    const groups = Array.isArray(api.groups) ? api.groups : [];
    for (const group of groups) {
      syncInternalGroupViewId(group as unknown as InternalGroupViewLike);
      if (group && typeof group === 'object' && groupZoneRoles.has(group)) {
        const canonicalRole =
          typeof group.id === 'string'
            ? inferCanonicalRoleFromGroupId(group.id)
            : null;
        if (canonicalRole && groupZoneRoles.get(group) !== canonicalRole) {
          groupZoneRoles.set(group, canonicalRole);
        }
      }
    }

    const component = (
      api as unknown as {
        component?: {
          _groups?: Map<string, { value?: InternalGroupViewLike }>;
          gridview?: { root?: unknown; _root?: unknown };
        };
      }
    ).component;

    const registry = component?._groups;
    if (registry && typeof registry.entries === 'function') {
      for (const [key, entry] of [...registry.entries()]) {
        const value = entry?.value;
        syncInternalGroupViewId(value);
        const actualId = value?.id;
        if (
          typeof actualId === 'string' &&
          actualId !== key &&
          !registry.has(actualId)
        ) {
          registry.delete(key);
          registry.set(actualId, entry);
        }
      }
    }

    const gridRoot = component?.gridview?.root ?? component?.gridview?._root;
    if (gridRoot) {
      syncGridviewLeafNodeIds(gridRoot);
    }
  } catch {
    // Guard against Dockview private structure changes across minor updates.
  }
}

/**
 * Single audited entry point for assigning a Dockview group's zone role and
 * canonical group id while atomically synchronizing Dockview's internal registry.
 */
export function assignDockviewGroupIdAndRole(
  api: DockviewApi,
  group: IDockviewGroupPanel | { id: string },
  nextId: string,
  role: DockviewGroupZoneRole
): void {
  setDockviewGroupRole(group, role);

  const groups = Array.isArray(api?.groups) ? api.groups : [];
  const hasConflictingGroup = groups.some(
    (candidate) => candidate !== group && candidate.id === nextId
  );

  if (group.id !== nextId && !hasConflictingGroup) {
    try {
      (group as { id: string }).id = nextId;
    } catch {
      // WeakMap role metadata still preserves zone identity if group.id is frozen.
    }
  }

  syncDockviewGroupRegistry(api);
}
