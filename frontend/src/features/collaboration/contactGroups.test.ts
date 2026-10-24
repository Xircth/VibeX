import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildContactSections,
  createContactGroup,
  deleteContactGroup,
  listContactGroups,
  readCollapsedSections,
  renameContactGroup,
  reorderContactGroups,
  setThreadGroup,
  UNGROUPED_SECTION_ID,
  withThreadGroup,
  writeCollapsedSections,
} from './contactGroups';
import type { CollaborationCaller } from './threadApi';

const caller = (
  impl: (method: string, params: Record<string, unknown> | undefined) => unknown
) =>
  vi.fn(
    async (
      _service: string,
      method: string,
      params?: Record<string, unknown>
    ) => impl(method, params)
  ) as unknown as CollaborationCaller & ReturnType<typeof vi.fn>;

const group = (group_id: string, name: string, sort_order: number) => ({
  group_id,
  workspace_id: 'w',
  name,
  sort_order,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

describe('contactGroups api', () => {
  it('lists groups sorted by sort_order, null when unavailable', async () => {
    const call = caller(() => ({
      groups: [group('g2', 'B', 1), group('g1', 'A', 0)],
    }));
    await expect(listContactGroups(call, 'w')).resolves.toEqual([
      group('g1', 'A', 0),
      group('g2', 'B', 1),
    ]);
    expect(call).toHaveBeenCalledWith('collaboration', 'contactGroup.list', {
      workspaceId: 'w',
    });
    await expect(
      listContactGroups(
        caller(() => {
          throw new Error('unknown method');
        }),
        'w'
      )
    ).resolves.toBeNull();
    await expect(
      listContactGroups(
        caller(() => ({})),
        'w'
      )
    ).resolves.toBeNull();
  });

  it('sends create/rename/delete/reorder/setGroup per the contract', async () => {
    const g9 = group('g9', 'New', 0);
    const call = caller((method, input) => {
      if (method === 'contactGroup.create') return { group: g9 };
      if (method === 'contactGroup.rename')
        return { group: { ...g9, name: input?.name } };
      if (method === 'contactGroup.delete')
        return {
          groupId: 'g9',
          deleted: true,
          ungroupedThreadIds: ['s1', 'direct:a'],
        };
      if (method === 'contactGroup.reorder')
        return { groups: [group('g1', 'One', 1), group('g2', 'Two', 0)] };
      if (method === 'thread.setGroup')
        return { threadId: input?.threadId, groupId: input?.groupId };
      return {};
    });
    await expect(createContactGroup(call, 'w', 'New')).resolves.toEqual(g9);
    await expect(renameContactGroup(call, 'g9', 'Renamed')).resolves.toEqual({
      ...g9,
      name: 'Renamed',
    });
    await expect(deleteContactGroup(call, 'g9')).resolves.toEqual({
      groupId: 'g9',
      deleted: true,
      ungroupedThreadIds: ['s1', 'direct:a'],
    });
    await expect(
      reorderContactGroups(call, 'w', ['g2', 'g1'])
    ).resolves.toMatchObject([{ group_id: 'g2' }, { group_id: 'g1' }]);
    await expect(setThreadGroup(call, 'direct:a', 'g1')).resolves.toEqual({
      threadId: 'direct:a',
      groupId: 'g1',
    });
    await setThreadGroup(call, 'direct:a', null);
    expect(call.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['contactGroup.create', { workspaceId: 'w', name: 'New' }],
      ['contactGroup.rename', { groupId: 'g9', name: 'Renamed' }],
      ['contactGroup.delete', { groupId: 'g9' }],
      ['contactGroup.reorder', { workspaceId: 'w', groupIds: ['g2', 'g1'] }],
      ['thread.setGroup', { threadId: 'direct:a', groupId: 'g1' }],
      ['thread.setGroup', { threadId: 'direct:a', groupId: null }],
    ]);
  });

  it('rejects empty names and duplicate reorder ids without calling', async () => {
    const call = caller(() => ({}));
    await expect(createContactGroup(call, 'w', '   ')).rejects.toThrow();
    await expect(renameContactGroup(call, 'g', '')).rejects.toThrow();
    await expect(reorderContactGroups(call, 'w', ['a', 'a'])).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates write failures so the UI can roll back', async () => {
    const call = caller(() => {
      throw new Error('boom');
    });
    await expect(setThreadGroup(call, 't', 'g')).rejects.toThrow('boom');
  });
});

describe('buildContactSections', () => {
  const entries = [
    { key: 'a', groupId: 'g2' },
    { key: 'b' },
    { key: 'c', groupId: 'gone' },
    { key: 'd', groupId: 'g1' },
  ];

  it('returns null without groups (flat list)', () => {
    expect(buildContactSections(entries, [], '未分组')).toBeNull();
    expect(buildContactSections(entries, null, '未分组')).toBeNull();
  });

  it('orders groups by sort_order and puts 未分组 last', () => {
    const sections = buildContactSections(
      entries,
      [group('g2', 'Two', 2), group('g1', 'One', 1)],
      '未分组'
    )!;
    expect(sections.map((s) => [s.id, s.entries.map((e) => e.key)])).toEqual([
      ['g1', ['d']],
      ['g2', ['a']],
      [UNGROUPED_SECTION_ID, ['b', 'c']],
    ]);
    expect(sections[2]).toMatchObject({ name: '未分组', ungrouped: true });
  });
});

describe('local state helpers', () => {
  beforeEach(() => window.localStorage.clear());

  it('moves a thread optimistically', () => {
    expect(
      withThreadGroup(
        [
          { thread_id: 'x', group_id: 'g1' },
          { thread_id: 'y', group_id: null },
        ],
        'x',
        null
      )
    ).toEqual([
      { thread_id: 'x', group_id: null },
      { thread_id: 'y', group_id: null },
    ]);
  });

  it('persists collapsed sections per workspace', () => {
    writeCollapsedSections('w1', new Set(['g1', UNGROUPED_SECTION_ID]));
    expect([...readCollapsedSections('w1')]).toEqual([
      'g1',
      UNGROUPED_SECTION_ID,
    ]);
    expect(readCollapsedSections('w2').size).toBe(0);
    window.localStorage.setItem(
      'vibex.collaboration.contactGroups.collapsed.w3',
      '{bad'
    );
    expect(readCollapsedSections('w3').size).toBe(0);
  });
});
