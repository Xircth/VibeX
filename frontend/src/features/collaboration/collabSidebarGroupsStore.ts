import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** A user-defined folder in the collaboration sidebar list. */
export interface CollabSidebarGroup {
  id: string;
  name: string;
  collapsed: boolean;
  /** Thread list keys (`member:<id>` / `group:<id>`), in insertion order. */
  itemKeys: string[];
}

interface CollabSidebarGroupsState {
  /** Folders in creation order. */
  groups: CollabSidebarGroup[];
  createGroup: (name: string, itemKey?: string) => string;
  renameGroup: (id: string, name: string) => void;
  deleteGroup: (id: string) => void;
  /** Move an item into a folder, or out of every folder when `groupId` is null. */
  moveItem: (itemKey: string, groupId: string | null) => void;
  toggleCollapsed: (id: string) => void;
}

const newId = () =>
  `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const without = (groups: CollabSidebarGroup[], itemKey: string) =>
  groups.map((g) =>
    g.itemKeys.includes(itemKey)
      ? { ...g, itemKeys: g.itemKeys.filter((k) => k !== itemKey) }
      : g
  );

export const useCollabSidebarGroupsStore = create<CollabSidebarGroupsState>()(
  persist(
    (set) => ({
      groups: [],
      createGroup: (name, itemKey) => {
        const id = newId();
        set((s) => ({
          groups: [
            ...(itemKey ? without(s.groups, itemKey) : s.groups),
            { id, name, collapsed: false, itemKeys: itemKey ? [itemKey] : [] },
          ],
        }));
        return id;
      },
      renameGroup: (id, name) =>
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)),
        })),
      deleteGroup: (id) =>
        set((s) => ({ groups: s.groups.filter((g) => g.id !== id) })),
      moveItem: (itemKey, groupId) =>
        set((s) => ({
          groups: without(s.groups, itemKey).map((g) =>
            g.id === groupId ? { ...g, itemKeys: [...g.itemKeys, itemKey] } : g
          ),
        })),
      toggleCollapsed: (id) =>
        set((s) => ({
          groups: s.groups.map((g) =>
            g.id === id ? { ...g, collapsed: !g.collapsed } : g
          ),
        })),
    }),
    { name: 'collab-sidebar-groups', version: 1 }
  )
);

export interface SidebarSection<T> {
  group: CollabSidebarGroup | null;
  items: T[];
}

/**
 * Split the (already sorted) thread list into the ungrouped section followed
 * by folders in creation order. Keys that no longer exist are dropped; an item
 * claimed by several folders (corrupt storage) stays in the first one.
 */
export function sectionThreadItems<T extends { key: string }>(
  items: readonly T[],
  groups: readonly CollabSidebarGroup[]
): SidebarSection<T>[] {
  const owner = new Map<string, string>();
  for (const g of groups)
    for (const k of g.itemKeys) if (!owner.has(k)) owner.set(k, g.id);
  const ungrouped: T[] = [];
  const byGroup = new Map<string, T[]>(groups.map((g) => [g.id, []]));
  for (const item of items) {
    const gid = owner.get(item.key);
    if (gid) byGroup.get(gid)!.push(item);
    else ungrouped.push(item);
  }
  return [
    { group: null, items: ungrouped },
    ...groups.map((g) => ({ group: g, items: byGroup.get(g.id)! })),
  ];
}
