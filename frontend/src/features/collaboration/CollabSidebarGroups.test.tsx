import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';

import {
  sectionThreadItems,
  useCollabSidebarGroupsStore,
} from './collabSidebarGroupsStore';
import { deriveMemberBotAvatar } from './MemberBotAvatar';
import { ThreadList } from './ThreadList';
import type { ThreadListItem } from './threadModel';

const idle = { state: 'idle' as const, line: null, busyThreads: [], queued: 0 };
const member = (id: string, nickname: string): ThreadListItem => ({
  kind: 'member',
  key: `member:${id}`,
  member: { memberId: id, nickname, seats: [] },
  presence: idle,
  attention: 0,
  pinned: false,
  activity: {},
});
const items: ThreadListItem[] = [
  member('m1', 'Alex'),
  member('m2', 'Bella'),
  {
    kind: 'group',
    key: 'group:g1',
    group: { spaceId: 'g1', name: '登录重构', memberIds: ['m1', 'm2'] },
    pinned: false,
    activity: {},
    attention: 0,
  },
];

function setup() {
  const onSelect = vi.fn();
  const utils = render(
    <ThreadList
      items={items}
      selectedKey={null}
      query=""
      avatarFor={(id) => deriveMemberBotAvatar(id)}
      onQueryChange={vi.fn()}
      onSelect={onSelect}
      onTogglePin={vi.fn()}
      onNewGroup={vi.fn()}
      onNewMember={vi.fn()}
    />
  );
  return { ...utils, onSelect, user: userEvent.setup() };
}

const store = () => useCollabSidebarGroupsStore.getState();
const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el);
const folderEl = (id: string) => screen.getByTestId(`collab-folder-${id}`);

describe('collaboration sidebar groups', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  beforeEach(() => {
    useCollabSidebarGroupsStore.setState({ groups: [] });
    localStorage.clear();
  });

  it('header has no segmented control, only the three buttons', () => {
    setup();
    const head = document.querySelector('.collab-list-head') as HTMLElement;
    expect(within(head).queryAllByRole('radio')).toHaveLength(0);
    expect(
      within(head)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'))
    ).toEqual(['搜索成员或群聊', '新建成员', '创建群聊']);
  });

  it('creates a group from the row context menu and renames it inline', async () => {
    const { user } = setup();
    rightClick(screen.getByTestId('collab-row-member:m1'));
    await user.click(screen.getByRole('menuitem', { name: '新建分组' }));
    const [g] = store().groups;
    expect(g).toMatchObject({ name: '新分组', itemKeys: ['member:m1'] });
    const input = await screen.findByRole('textbox', { name: '分组名称' });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, '前端{Enter}');
    expect(store().groups[0].name).toBe('前端');
    expect(
      within(folderEl(g.id)).getByTestId('collab-row-member:m1')
    ).toBeTruthy();
    // ungrouped first, then folders
    const order = Array.from(
      document.querySelectorAll('[data-testid^="collab-row-"],.collab-folder')
    ).map((el) => el.getAttribute('data-testid'));
    expect(order.indexOf(`collab-folder-${g.id}`)).toBeGreaterThan(
      order.indexOf('collab-row-group:g1')
    );
  });

  it('moves into an existing group and removes from it', async () => {
    const id = store().createGroup('A', 'member:m1');
    const { user } = setup();
    rightClick(screen.getByTestId('collab-row-group:g1'));
    expect(screen.queryByRole('menuitem', { name: '移出分组' })).toBeNull();
    await user.hover(screen.getByRole('menuitem', { name: '移动到分组' }));
    await user.click(await screen.findByRole('menuitem', { name: 'A' }));
    expect(store().groups[0].itemKeys).toEqual(['member:m1', 'group:g1']);
    rightClick(within(folderEl(id)).getByTestId('collab-row-member:m1'));
    await user.click(screen.getByRole('menuitem', { name: '移出分组' }));
    expect(store().groups[0].itemKeys).toEqual(['group:g1']);
  });

  it('renames and deletes from the group header menu; delete returns items', async () => {
    const id = store().createGroup('A', 'member:m2');
    const { user } = setup();
    rightClick(folderEl(id).querySelector('.collab-folder-head')!);
    await user.click(screen.getByRole('menuitem', { name: '重命名' }));
    const input = await screen.findByRole('textbox', { name: '分组名称' });
    await user.clear(input);
    await user.type(input, 'B');
    input.blur();
    expect(store().groups[0].name).toBe('B');
    rightClick(folderEl(id).querySelector('.collab-folder-head')!);
    await user.click(screen.getByRole('menuitem', { name: '删除分组' }));
    expect(store().groups).toHaveLength(0);
    expect(screen.getByTestId('collab-row-member:m2')).toBeTruthy();
  });

  it('collapses a group and persists the state', async () => {
    const id = store().createGroup('A', 'member:m1');
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: '收起 A' }));
    expect(screen.queryByTestId('collab-row-member:m1')).toBeNull();
    expect(
      JSON.parse(localStorage.getItem('collab-sidebar-groups')!).state.groups[0]
        .collapsed
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: '展开 A' }));
    expect(screen.getByTestId('collab-row-member:m1')).toBeTruthy();
    expect(id).toBeTruthy();
  });

  it('drops missing items and keeps an item in one group', () => {
    const sections = sectionThreadItems(items, [
      {
        id: 'a',
        name: 'A',
        collapsed: false,
        itemKeys: ['member:gone', 'member:m1'],
      },
      { id: 'b', name: 'B', collapsed: false, itemKeys: ['member:m1'] },
    ]);
    expect(sections.map((s) => s.items.map((i) => i.key))).toEqual([
      ['member:m2', 'group:g1'],
      ['member:m1'],
      [],
    ]);
  });

  it('row click still selects', async () => {
    const { user, onSelect } = setup();
    await user.click(screen.getByRole('button', { name: 'Alex' }));
    expect(onSelect).toHaveBeenCalledWith('member:m1');
  });
});
