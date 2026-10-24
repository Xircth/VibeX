import type { ChatListEntry } from './spaceModel';

export type ContactListSort = 'name' | 'type' | 'activity';
export type ContactTypeFilter = 'group' | 'direct';

export type ContactChromeState = {
  pinned: string[];
  hidden: string[];
};

const EMPTY: ContactChromeState = { pinned: [], hidden: [] };

export function contactChromeStorageKey(workspaceId: string): string {
  return `vibex.collaboration.contactChrome.${workspaceId}`;
}

function asIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function readContactChrome(
  workspaceId: string,
  storage: Pick<Storage, 'getItem'> | undefined = typeof window !== 'undefined'
    ? window.localStorage
    : undefined
): ContactChromeState {
  if (!storage || !workspaceId) return { ...EMPTY, pinned: [], hidden: [] };
  try {
    const raw = storage.getItem(contactChromeStorageKey(workspaceId));
    if (!raw) return { pinned: [], hidden: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { pinned: [], hidden: [] };
    }
    const record = parsed as Record<string, unknown>;
    return {
      pinned: asIdList(record.pinned),
      hidden: asIdList(record.hidden),
    };
  } catch {
    return { pinned: [], hidden: [] };
  }
}

export function writeContactChrome(
  workspaceId: string,
  chrome: ContactChromeState,
  storage: Pick<Storage, 'setItem'> | undefined = typeof window !== 'undefined'
    ? window.localStorage
    : undefined
): void {
  if (!storage || !workspaceId) return;
  try {
    storage.setItem(
      contactChromeStorageKey(workspaceId),
      JSON.stringify({
        pinned: asIdList(chrome.pinned),
        hidden: asIdList(chrome.hidden),
      })
    );
  } catch {
    // Storage quota: chrome just will not persist.
  }
}

function withoutId(ids: readonly string[], id: string): string[] {
  return ids.filter((item) => item !== id);
}

export function togglePinnedThread(
  chrome: ContactChromeState,
  threadId: string
): ContactChromeState {
  const id = threadId.trim();
  if (!id) return chrome;
  if (chrome.pinned.includes(id)) {
    return { ...chrome, pinned: withoutId(chrome.pinned, id) };
  }
  return {
    pinned: [...withoutId(chrome.pinned, id), id],
    hidden: withoutId(chrome.hidden, id),
  };
}

export function toggleHiddenThread(
  chrome: ContactChromeState,
  threadId: string
): ContactChromeState {
  const id = threadId.trim();
  if (!id) return chrome;
  if (chrome.hidden.includes(id)) {
    return { ...chrome, hidden: withoutId(chrome.hidden, id) };
  }
  return {
    pinned: withoutId(chrome.pinned, id),
    hidden: [...withoutId(chrome.hidden, id), id],
  };
}

export function chatEntryThreadId(entry: ChatListEntry): string | null {
  if (entry.threadId) return entry.threadId;
  if (entry.type === 'direct') {
    return entry.member.member_id
      ? `direct:${entry.member.member_id}`
      : entry.member.conversation_id || null;
  }
  return entry.spaceId || null;
}

export function conversationIdForCopy(entry: ChatListEntry): string {
  if (entry.type === 'direct') {
    return (
      entry.member.conversation_id || chatEntryThreadId(entry) || entry.spaceId
    );
  }
  return chatEntryThreadId(entry) || entry.spaceId;
}

function activityStamp(entry: ChatListEntry): number {
  const parsed = Date.parse(entry.lastActivityAt ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareByName(left: ChatListEntry, right: ChatListEntry): number {
  return left.name.localeCompare(right.name, 'zh-CN');
}

function sortVisible(
  entries: ChatListEntry[],
  sort: ContactListSort
): ChatListEntry[] {
  if (sort === 'name') {
    return [...entries].sort(compareByName);
  }
  if (sort === 'activity') {
    return [...entries].sort((left, right) => {
      const delta = activityStamp(right) - activityStamp(left);
      return delta !== 0 ? delta : compareByName(left, right);
    });
  }
  return entries;
}

export function applyContactListView(
  entries: readonly ChatListEntry[],
  chrome: ContactChromeState,
  sort: ContactListSort,
  typeFilter: ContactTypeFilter
): { visible: ChatListEntry[]; hidden: ChatListEntry[] } {
  const hiddenIds = new Set(chrome.hidden);
  const pinnedIds = chrome.pinned;
  const hidden: ChatListEntry[] = [];
  const rest: ChatListEntry[] = [];
  const byId = new Map<string, ChatListEntry>();
  for (const entry of entries) {
    const id = chatEntryThreadId(entry);
    if (id) byId.set(id, entry);
    const matchesType = sort !== 'type' || entry.type === typeFilter;
    if (id && hiddenIds.has(id)) {
      if (matchesType) hidden.push(entry);
      continue;
    }
    if (!matchesType) continue;
    rest.push(entry);
  }
  const pinned: ChatListEntry[] = [];
  const pinnedSet = new Set<string>();
  for (const id of pinnedIds) {
    const entry = byId.get(id);
    if (!entry) continue;
    if (hiddenIds.has(id)) continue;
    if (sort === 'type' && entry.type !== typeFilter) continue;
    pinned.push(entry);
    pinnedSet.add(id);
  }
  const unpinned = rest.filter((entry) => {
    const id = chatEntryThreadId(entry);
    return !id || !pinnedSet.has(id);
  });
  return {
    visible: [...pinned, ...sortVisible(unpinned, sort)],
    hidden,
  };
}

export function cycleTypeFilter(
  sort: ContactListSort,
  typeFilter: ContactTypeFilter
): { sort: ContactListSort; typeFilter: ContactTypeFilter } {
  if (sort !== 'type') {
    return { sort: 'type', typeFilter: 'group' };
  }
  return {
    sort: 'type',
    typeFilter: typeFilter === 'group' ? 'direct' : 'group',
  };
}
