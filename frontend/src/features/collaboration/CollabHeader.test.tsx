import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';

import { filterSearchEntries } from './CollabSearchModal';
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

const group = (
  id: string,
  name: string,
  memberIds: string[]
): ThreadListItem => ({
  kind: 'group',
  key: `group:${id}`,
  group: { spaceId: id, name, memberIds },
  pinned: false,
  activity: {},
  attention: 0,
});

const items = [
  member('m1', 'Alex'),
  member('m2', 'Bella'),
  group('g1', '登录重构', ['m1', 'm2']),
];

function setup() {
  const onSelect = vi.fn();
  const onNewMember = vi.fn();
  render(
    <ThreadList
      items={items}
      selectedKey={null}
      filter="all"
      query=""
      avatarFor={(id) => deriveMemberBotAvatar(id)}
      onFilterChange={vi.fn()}
      onQueryChange={vi.fn()}
      onSelect={onSelect}
      onTogglePin={vi.fn()}
      onNewGroup={vi.fn()}
      onNewMember={onNewMember}
    />
  );
  return { onSelect, onNewMember, user: userEvent.setup() };
}

describe('collaboration sidebar header', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('has no 协作 title and keeps the segmented control on the header row', () => {
    setup();
    expect(screen.queryByRole('heading', { name: '协作' })).toBeNull();
    const head = screen
      .getByTestId('collab-thread-list')
      .querySelector('.collab-list-head') as HTMLElement;
    expect(head).not.toBeNull();
    expect(within(head).getByRole('radio', { name: '全部' })).toBeTruthy();
    const buttons = within(head).getAllByRole('button');
    const names = buttons.map((b) => b.getAttribute('aria-label'));
    expect(names.indexOf('搜索成员或群聊')).toBe(names.indexOf('新建成员') - 1);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('renders an icon in every segmented item', () => {
    setup();
    for (const name of ['全部', '成员', '群聊']) {
      const radio = screen.getByRole('radio', { name });
      const label = radio.closest('label') ?? radio.parentElement!;
      expect(label.querySelector('svg')).not.toBeNull();
    }
  });

  it('search button opens the modal; Esc and backdrop close it', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: '搜索成员或群聊' }));
    expect(screen.getByTestId('collab-search-modal')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('collab-search-modal')).toBeNull();
    await user.click(screen.getByRole('button', { name: '搜索成员或群聊' }));
    await user.click(screen.getByTestId('collab-search-backdrop'));
    expect(screen.queryByTestId('collab-search-modal')).toBeNull();
  });

  it('filters by name and group member names, shows group members', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: '搜索成员或群聊' }));
    const groupRow = screen.getByTestId('collab-search-row-group:g1');
    expect(groupRow.textContent).toContain('Alex, Bella');
    const input = screen.getByRole('combobox');
    await user.type(input, 'bel');
    expect(screen.getAllByRole('option').map((o) => o.dataset.testid)).toEqual([
      'collab-search-row-member:m2',
      'collab-search-row-group:g1',
    ]);
    await user.clear(input);
    await user.type(input, 'zzz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('没有匹配的成员或群聊')).toBeTruthy();
    expect(
      filterSearchEntries([{ name: 'X', memberNames: ['Yo'] }], 'yo')
    ).toHaveLength(1);
  });

  it('selecting a member or group calls the list select handler', async () => {
    const { user, onSelect } = setup();
    await user.click(screen.getByRole('button', { name: '搜索成员或群聊' }));
    await user.click(screen.getByTestId('collab-search-row-member:m2'));
    expect(onSelect).toHaveBeenLastCalledWith('member:m2');
    expect(screen.queryByTestId('collab-search-modal')).toBeNull();

    await user.click(screen.getByRole('button', { name: '搜索成员或群聊' }));
    await user.type(screen.getByRole('combobox'), '登录');
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('group:g1');

    await user.click(screen.getByRole('button', { name: '搜索成员或群聊' }));
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('member:m2');
  });
});
