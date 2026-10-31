import { describe, expect, it, vi } from 'vitest';

import {
  buildContactRowMenuItems,
  CONTACT_ROW_MENU_COPY,
  moveTargetsForEntry,
} from './contactRowMenu';
import type { ChatListEntry } from './spaceModel';
import { UNGROUPED_SECTION_ID } from './contactGroups';

const dm: ChatListEntry = {
  type: 'direct',
  key: 'direct:a',
  spaceId: 'unassigned:w',
  name: '小A',
  member: {
    kind: 'agent',
    member_id: 'a',
    nickname: '小A',
    conversation_id: 'conv-a',
  },
  fromSpace: false,
  threadId: 'direct:a',
};

const group: ChatListEntry = {
  type: 'group',
  key: 'group:s1',
  spaceId: 's1',
  name: '设计',
  members: [],
  threadId: 's1',
  groupId: 'g1',
};

const handlers = () => ({
  onPin: vi.fn(),
  onMove: vi.fn(),
  onToggleUnread: vi.fn(),
  onRename: vi.fn(),
  onCopyId: vi.fn(),
  onHide: vi.fn(),
  onDelete: vi.fn(),
});

const labels = (items: ReturnType<typeof buildContactRowMenuItems>) =>
  items.map((item) =>
    item.type === 'separator'
      ? '---'
      : item.type === 'emoji-row'
        ? 'emojis'
        : item.label
  );

describe('contact row menu', () => {
  it('lists pin, move, unread, rename 助手, copy, hide and delete for a DM', () => {
    const items = buildContactRowMenuItems({
      entry: dm,
      pinned: false,
      hidden: false,
      unread: false,
      moveTargets: [
        { id: 'g1', name: '核心' },
        { id: UNGROUPED_SECTION_ID, name: '未分组' },
      ],
      ...handlers(),
    });
    expect(labels(items)).toEqual([
      '置顶',
      '移至',
      '标为未读',
      '---',
      '重命名助手',
      '---',
      '复制对话 ID',
      '---',
      '从侧边栏隐藏',
      '删除',
    ]);
    const del = items.find(
      (item) => item.type !== 'separator' && item.id === 'delete'
    );
    expect(del && 'danger' in del && del.danger).toBe(true);
  });

  it('uses 群组 copy and the inverse actions when pinned, unread and hidden', () => {
    const items = buildContactRowMenuItems({
      entry: group,
      pinned: true,
      hidden: true,
      unread: true,
      moveTargets: [],
      ...handlers(),
    });
    expect(labels(items)).toEqual([
      '取消置顶',
      '标为已读',
      '---',
      '重命名群组',
      '---',
      '复制对话 ID',
      '---',
      '在侧边栏显示',
      '删除',
    ]);
  });

  it('omits 移至 when there is no other group', () => {
    expect(
      moveTargetsForEntry(dm, [{ id: UNGROUPED_SECTION_ID, name: '未分组' }])
    ).toEqual([]);
    expect(
      moveTargetsForEntry(group, [
        { id: 'g1', name: '核心' },
        { id: 'g2', name: '外部' },
        { id: UNGROUPED_SECTION_ID, name: '未分组' },
      ])
    ).toEqual([
      { id: 'g2', name: '外部' },
      { id: UNGROUPED_SECTION_ID, name: '未分组' },
    ]);
  });

  it('keeps screenshot copy as the default', () => {
    expect(CONTACT_ROW_MENU_COPY.renameAssistant).toBe('重命名助手');
    expect(CONTACT_ROW_MENU_COPY.moveTo).toBe('移至');
    expect(CONTACT_ROW_MENU_COPY.stepDownSupervisor).toBe('卸任主管');
  });

  it('omits delete/pin/move/hide and shows 卸任主管 for the Supervisor bot', () => {
    const onStepDownSupervisor = vi.fn();
    const items = buildContactRowMenuItems({
      entry: dm,
      pinned: false,
      hidden: false,
      unread: false,
      isSupervisor: true,
      moveTargets: [{ id: 'g1', name: '核心' }],
      ...handlers(),
      onStepDownSupervisor,
    });
    expect(labels(items)).toEqual([
      '标为未读',
      '---',
      '重命名助手',
      '---',
      '复制对话 ID',
      '---',
      '卸任主管',
    ]);
    expect(
      items.find((item) => item.type !== 'separator' && item.id === 'delete')
    ).toBeUndefined();
    const stepDown = items.find(
      (item) => item.type !== 'separator' && item.id === 'step-down-supervisor'
    );
    expect(stepDown).toBeDefined();
    if (stepDown && 'onSelect' in stepDown) {
      stepDown.onSelect?.();
    }
    expect(onStepDownSupervisor).toHaveBeenCalledTimes(1);
  });
});
