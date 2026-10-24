/**
 * Contact groups for the collaboration contact list (left sidebar).
 *
 * Groups live on the backend. This module is a thin client plus pure helpers.
 * Contract (all via `call('collaboration', method, input)`):
 *   contactGroup.list    { workspaceId }             -> { groups: ContactGroup[] }
 *   contactGroup.create  { workspaceId, name }       -> { group }  (appended last)
 *   contactGroup.rename  { groupId, name }           -> { group }
 *   contactGroup.delete  { groupId }                 -> { groupId, deleted, ungroupedThreadIds }
 *   contactGroup.reorder { workspaceId, groupIds }   -> { groups }  (all ids, once each)
 *   thread.setGroup      { threadId, groupId|null }  -> { threadId, groupId }
 *   thread.listSidebar   items[].group_id: string | null
 *
 * "未分组" is generated here and never stored. Only the collapsed state of
 * sections is local (localStorage).
 */
import type { CollaborationCaller } from './threadApi';

export type ContactGroup = {
  group_id: string;
  workspace_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type DeleteContactGroupResult = {
  groupId: string;
  deleted: true;
  ungroupedThreadIds: string[];
};

/** Section id used for the frontend-only "未分组" section. */
export const UNGROUPED_SECTION_ID = '__ungrouped__';

export type ContactSection<E> = {
  id: string;
  name: string;
  /** True for the generated "未分组" section (not renamable/deletable). */
  ungrouped: boolean;
  entries: E[];
};

export function sortContactGroups(
  groups: readonly ContactGroup[]
): ContactGroup[] {
  return [...groups].sort((a, b) => a.sort_order - b.sort_order);
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Contact group name must not be empty');
  return trimmed;
}

/** `contactGroup.list`; null when unavailable (older backend). */
export async function listContactGroups(
  call: CollaborationCaller,
  workspaceId: string
): Promise<ContactGroup[] | null> {
  try {
    const page = await call<{ groups?: ContactGroup[] }>(
      'collaboration',
      'contactGroup.list',
      { workspaceId }
    );
    return Array.isArray(page?.groups) ? sortContactGroups(page.groups) : null;
  } catch {
    return null;
  }
}

/** `contactGroup.create`; resolves the created group (throws on failure). */
export async function createContactGroup(
  call: CollaborationCaller,
  workspaceId: string,
  name: string
): Promise<ContactGroup> {
  const result = await call<{ group: ContactGroup }>(
    'collaboration',
    'contactGroup.create',
    { workspaceId, name: requireName(name) }
  );
  return result.group;
}

export async function renameContactGroup(
  call: CollaborationCaller,
  groupId: string,
  name: string
): Promise<ContactGroup> {
  const result = await call<{ group: ContactGroup }>(
    'collaboration',
    'contactGroup.rename',
    { groupId, name: requireName(name) }
  );
  return result.group;
}

/** Deleting a group moves its contacts back to 未分组 (group_id null). */
export async function deleteContactGroup(
  call: CollaborationCaller,
  groupId: string
): Promise<DeleteContactGroupResult> {
  const result = await call<DeleteContactGroupResult>(
    'collaboration',
    'contactGroup.delete',
    { groupId }
  );
  return {
    groupId: result?.groupId ?? groupId,
    deleted: true,
    ungroupedThreadIds: Array.isArray(result?.ungroupedThreadIds)
      ? result.ungroupedThreadIds
      : [],
  };
}

/** `groupIds` must list every group in the workspace exactly once. */
export async function reorderContactGroups(
  call: CollaborationCaller,
  workspaceId: string,
  groupIds: readonly string[]
): Promise<ContactGroup[]> {
  if (new Set(groupIds).size !== groupIds.length) {
    throw new Error('contactGroup.reorder groupIds must be unique');
  }
  const result = await call<{ groups: ContactGroup[] }>(
    'collaboration',
    'contactGroup.reorder',
    { workspaceId, groupIds: [...groupIds] }
  );
  return sortContactGroups(result.groups);
}

/** `thread.setGroup` (threadId: spaceId or `direct:<memberId>`); null -> 未分组. */
export async function setThreadGroup(
  call: CollaborationCaller,
  threadId: string,
  groupId: string | null
): Promise<{ threadId: string; groupId: string | null }> {
  const result = await call<{ threadId: string; groupId: string | null }>(
    'collaboration',
    'thread.setGroup',
    { threadId, groupId }
  );
  return {
    threadId: result?.threadId ?? threadId,
    groupId: result?.groupId ?? groupId,
  };
}

/**
 * Split the flat chat list into sections. Returns null when there are no
 * user-defined groups (render the flat list as before). Entries pointing at
 * unknown groups fall into 未分组, which is always last.
 */
export function buildContactSections<E extends { groupId?: string | null }>(
  entries: readonly E[],
  groups: readonly ContactGroup[] | null | undefined,
  ungroupedName: string
): ContactSection<E>[] | null {
  if (!groups || groups.length === 0) return null;
  const ordered = sortContactGroups(groups);
  const byId = new Map<string, ContactSection<E>>();
  const sections: ContactSection<E>[] = ordered.map((group) => {
    const section = {
      id: group.group_id,
      name: group.name,
      ungrouped: false,
      entries: [] as E[],
    };
    byId.set(group.group_id, section);
    return section;
  });
  const ungrouped: ContactSection<E> = {
    id: UNGROUPED_SECTION_ID,
    name: ungroupedName,
    ungrouped: true,
    entries: [],
  };
  for (const entry of entries) {
    const section = entry.groupId ? byId.get(entry.groupId) : undefined;
    (section ?? ungrouped).entries.push(entry);
  }
  return [...sections, ungrouped];
}

/** Apply a local (optimistic) group move to the sidebar item list. */
export function withThreadGroup<
  I extends { thread_id: string; group_id?: string | null },
>(items: readonly I[], threadId: string, groupId: string | null): I[] {
  return items.map((item) =>
    item.thread_id === threadId ? { ...item, group_id: groupId } : item
  );
}

const collapsedKey = (workspaceId: string) =>
  `vibex.collaboration.contactGroups.collapsed.${workspaceId}`;

/** Collapsed section ids (UI state only; the groups themselves are remote). */
export function readCollapsedSections(workspaceId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(collapsedKey(workspaceId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === 'string')
        : []
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsedSections(
  workspaceId: string,
  collapsed: ReadonlySet<string>
): void {
  try {
    window.localStorage.setItem(
      collapsedKey(workspaceId),
      JSON.stringify([...collapsed])
    );
  } catch {
    // Storage unavailable: collapsed state just won't persist.
  }
}
