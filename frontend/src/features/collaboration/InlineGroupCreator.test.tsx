import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { InlineGroupCreator } from './InlineGroupCreator';
import { deriveMemberBotAvatar } from './MemberBotAvatar';
import { ThreadList } from './ThreadList';

const idle = { state: 'idle' as const, line: null, busyThreads: [], queued: 0 };
const members = ['Alex', 'Blair', 'Casey'].map((nickname, i) => ({
  memberId: `m${i}`,
  nickname,
  avatar: deriveMemberBotAvatar(`m${i}`),
  presence: idle,
}));

describe('InlineGroupCreator', () => {
  it('needs at least two members before create is enabled', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<InlineGroupCreator members={members} onCreate={onCreate} />);
    const create = screen.getByRole('button', { name: '????' });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: 'Alex' }));
    expect((create as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: 'Casey' }));
    expect((create as HTMLButtonElement).disabled).toBe(false);
    await user.click(create);
    expect(onCreate).toHaveBeenCalledWith('Alex?Casey', ['m0', 'm2']);
  });

  it('filters the list with the search box', async () => {
    const user = userEvent.setup();
    render(<InlineGroupCreator members={members} onCreate={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: '????' }), 'bl');
    expect(screen.queryByRole('checkbox', { name: 'Alex' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Blair' })).toBeTruthy();
  });

  it('expands inline under the list header without a dialog', () => {
    render(
      <ThreadList
        items={[]}
        selectedKey={null}
        filter="all"
        query=""
        avatarFor={(id) => deriveMemberBotAvatar(id)}
        onFilterChange={vi.fn()}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        onTogglePin={vi.fn()}
        onNewGroup={vi.fn()}
        onNewMember={vi.fn()}
        groupCreatorOpen
        groupCreator={<InlineGroupCreator members={members} onCreate={vi.fn()} />}
      />
    );
    expect(screen.getByTestId('collab-group-inline')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen
        .getAllByRole('button', { name: '????' })
        .find((b) => b.getAttribute('aria-expanded') === 'true')
    ).toBeTruthy();
  });
});
