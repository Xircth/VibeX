import { describe, expect, it } from 'vitest';

import {
  applyContactListView,
  chatEntryThreadId,
  conversationIdForCopy,
  cycleTypeFilter,
  readContactChrome,
  toggleHiddenThread,
  togglePinnedThread,
  writeContactChrome,
} from './contactChrome';
import type { ChatListEntry } from './spaceModel';

const memory = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
};

const member = (
  id: string,
  name: string,
  at = '2026-01-02T00:00:00Z'
): ChatListEntry => ({
  type: 'direct',
  key: `direct:${id}`,
  spaceId: `unassigned:w`,
  name,
  member: {
    kind: 'agent',
    member_id: id,
    nickname: name,
    conversation_id: `conv-${id}`,
  },
  fromSpace: false,
  threadId: `direct:${id}`,
  lastActivityAt: at,
});

const group = (id: string, name: string, at: string): ChatListEntry => ({
  type: 'group',
  key: `group:${id}`,
  spaceId: id,
  name,
  members: [],
  threadId: id,
  lastActivityAt: at,
});

describe('contact chrome', () => {
  it('persists pin and hide lists per workspace', () => {
    const storage = memory();
    writeContactChrome('w1', { pinned: ['direct:a'], hidden: ['s1'] }, storage);
    expect(readContactChrome('w1', storage)).toEqual({
      pinned: ['direct:a'],
      hidden: ['s1'],
    });
    expect(readContactChrome('w2', storage)).toEqual({
      pinned: [],
      hidden: [],
    });
  });

  it('pins to the end of the pin order and unhides on pin', () => {
    const next = togglePinnedThread({ pinned: ['a'], hidden: ['b'] }, 'b');
    expect(next).toEqual({ pinned: ['a', 'b'], hidden: [] });
    expect(togglePinnedThread(next, 'a').pinned).toEqual(['b']);
  });

  it('hides by dropping the pin', () => {
    expect(toggleHiddenThread({ pinned: ['a', 'b'], hidden: [] }, 'a')).toEqual(
      { pinned: ['b'], hidden: ['a'] }
    );
  });

  it('copies the member conversation id for DMs and the thread id for groups', () => {
    expect(conversationIdForCopy(member('a', '小A'))).toBe('conv-a');
    expect(
      conversationIdForCopy(group('s1', '设计', '2026-01-01T00:00:00Z'))
    ).toBe('s1');
    expect(chatEntryThreadId(member('a', '小A'))).toBe('direct:a');
  });

  it('sorts by name, activity, and type, with pins first and hidden last', () => {
    const entries = [
      group('s1', '设计', '2026-01-03T00:00:00Z'),
      member('b', '小B', '2026-01-02T12:00:00Z'),
      member('a', '小A', '2026-01-02T00:00:00Z'),
    ];
    const chrome = { pinned: ['direct:b'], hidden: ['s1'] };
    const named = applyContactListView(entries, chrome, 'name', 'group');
    expect(named.visible.map((item) => item.name)).toEqual(['小B', '小A']);
    expect(named.hidden.map((item) => item.name)).toEqual(['设计']);

    const activity = applyContactListView(
      entries,
      { pinned: [], hidden: [] },
      'activity',
      'group'
    );
    expect(activity.visible.map((item) => item.name)).toEqual([
      '设计',
      '小B',
      '小A',
    ]);

    const groupsOnly = applyContactListView(
      entries,
      { pinned: [], hidden: [] },
      'type',
      'group'
    );
    expect(groupsOnly.visible.map((item) => item.name)).toEqual(['设计']);
    const assistants = applyContactListView(
      entries,
      { pinned: [], hidden: [] },
      'type',
      'direct'
    );
    expect(assistants.visible.map((item) => item.name)).toEqual(['小B', '小A']);
  });

  it('cycles 按类型 from inactive → 群聊 → 助手', () => {
    expect(cycleTypeFilter('activity', 'group')).toEqual({
      sort: 'type',
      typeFilter: 'group',
    });
    expect(cycleTypeFilter('type', 'group')).toEqual({
      sort: 'type',
      typeFilter: 'direct',
    });
    expect(cycleTypeFilter('type', 'direct')).toEqual({
      sort: 'type',
      typeFilter: 'group',
    });
  });
});
