import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { MessageTurn } from 'shared/types';

import { GroupChat, type GroupSeat } from './GroupChat';
import { deriveMemberBotAvatar } from './MemberBotAvatar';
import { directReceipts } from './MemberDirectChat';
import { ApprovalCard, AskCard } from './ThreadCards';
import { ThreadList } from './ThreadList';
import { buildThreadList, collectMembers } from './threadModel';

const idle = { state: 'idle' as const, line: null, busyThreads: [], queued: 0 };

function seat(
  memberId: string,
  nickname: string,
  extra: Partial<GroupSeat> = {}
): GroupSeat {
  return {
    memberId,
    nickname,
    conversationId: `c-${memberId}`,
    avatar: deriveMemberBotAvatar(memberId),
    presence: idle,
    busyElsewhere: null,
    ...extra,
  };
}

function groupChat(overrides: Partial<Parameters<typeof GroupChat>[0]> = {}) {
  const props = {
    groupName: '登录重构',
    seats: [seat('m1', 'Alex'), seat('m2', 'Blair')],
    messages: [],
    cardStatus: {},
    onSend: vi.fn(),
    onPreviewWake: vi.fn(async () => ({ willWake: 2, asleep: 1 })),
    onResolveCard: vi.fn(),
    ...overrides,
  };
  render(<GroupChat {...props} />);
  return props;
}

describe('collaboration threads UI', () => {
  it('asks to confirm a broadcast send and lets the user send anyway', async () => {
    const user = userEvent.setup();
    const props = groupChat();
    const box = screen.getByRole('textbox', { name: '发消息，@ 指定成员' });
    await user.type(box, '大家看下');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(props.onPreviewWake).toHaveBeenCalledWith('大家看下');
    expect(
      await screen.findByText('将唤醒 2 个成员（含休眠中的 1 个）')
    ).toBeTruthy();
    expect(props.onSend).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '仍然发送' }));
    expect(props.onSend).toHaveBeenCalledWith('大家看下', []);
  });

  it('sends an @-mention directly without a wake confirm', async () => {
    const user = userEvent.setup();
    const props = groupChat();
    await user.type(
      screen.getByRole('textbox', { name: '发消息，@ 指定成员' }),
      '@Alex 看下'
    );
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(props.onPreviewWake).not.toHaveBeenCalled();
    expect(props.onSend).toHaveBeenCalledWith('@Alex 看下', ['Alex']);
  });

  it('folds agent-to-agent messages until expanded', async () => {
    const user = userEvent.setup();
    groupChat({
      messages: [
        {
          seq: 1,
          origin: 'agent',
          envelope: {
            actor: 'vibex://space/g/member/Alex',
            content: '内部讨论一',
          },
        },
        {
          seq: 2,
          origin: 'agent',
          envelope: {
            actor: 'vibex://space/g/member/Blair',
            content: '内部讨论二',
          },
        },
      ],
    });
    expect(screen.queryByText('内部讨论一')).toBeNull();
    await user.click(
      screen.getByRole('button', { name: /成员间消息 2 条已折叠/ })
    );
    expect(screen.getByText('内部讨论一')).toBeTruthy();
  });

  it('resolves approval and ask cards', async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    const { rerender } = render(
      <ApprovalCard
        card={{
          kind: 'approval',
          id: 'k1',
          action: '删除构建产物',
          command: 'rm -rf dist',
          reason: '清理',
        }}
        from="Alex"
        onResolve={onResolve}
      />
    );
    await user.click(screen.getByRole('button', { name: '允许一次' }));
    expect(onResolve).toHaveBeenCalledWith('allow_once');
    rerender(
      <ApprovalCard
        card={{
          kind: 'approval',
          id: 'k1',
          action: '删除构建产物',
          command: 'rm -rf dist',
          reason: '清理',
        }}
        resolution={{ status: 'resolved', decision: 'deny' }}
        onResolve={onResolve}
      />
    );
    expect(screen.getByText('已处理：拒绝')).toBeTruthy();

    const onAnswer = vi.fn();
    render(
      <AskCard
        card={{
          kind: 'ask',
          id: 'k2',
          question: '用 pnpm 还是 npm？',
          options: ['pnpm', 'npm'],
        }}
        onAnswer={onAnswer}
      />
    );
    await user.click(screen.getByRole('button', { name: 'pnpm' }));
    expect(onAnswer).toHaveBeenCalledWith('pnpm');
  });

  it('pins, filters and shows the needs-you badge in the list', async () => {
    const user = userEvent.setup();
    const { members, groups } = collectMembers(
      [{ space_id: 'g1', name: '登录重构' }],
      {
        'unassigned:ws': [
          {
            member_id: 'm1',
            nickname: 'Alex',
            kind: 'agent',
            conversation_id: 'c1',
          },
        ],
        g1: [
          {
            member_id: 'm1',
            nickname: 'Alex',
            kind: 'agent',
            conversation_id: 'c1g',
          },
        ],
      },
      'unassigned:ws'
    );
    const items = buildThreadList({
      members,
      groups,
      conversations: new Map(),
      activity: {},
      pins: [],
      attentionByMember: new Map([['m1', 1]]),
    });
    const onTogglePin = vi.fn();
    const onFilterChange = vi.fn();
    render(
      <ThreadList
        items={items}
        selectedKey="member:m1"
        filter="all"
        query=""
        avatarFor={(id) => deriveMemberBotAvatar(id)}
        onFilterChange={onFilterChange}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
        onTogglePin={onTogglePin}
        onNewGroup={vi.fn()}
        onNewMember={vi.fn()}
      />
    );
    const row = screen.getByTestId('collab-row-member:m1');
    expect(within(row).getAllByLabelText('等你处理').length).toBeGreaterThan(0);
    await user.click(within(row).getByRole('button', { name: '置顶' }));
    expect(onTogglePin).toHaveBeenCalledWith('member:m1');
    await user.click(screen.getByRole('radio', { name: '群聊' }));
    expect(onFilterChange).toHaveBeenCalledWith('group');
  });

  it('derives three-state direct receipts from the timeline', () => {
    const turn = (role: 'user' | 'assistant'): MessageTurn =>
      ({ id: role, role, blocks: [] }) as unknown as MessageTurn;
    expect(
      directReceipts(
        [
          { key: 'u1', turn: turn('user') },
          { key: 'a1', turn: turn('assistant') },
          { key: 'u2', turn: turn('user') },
        ],
        {},
        false
      )
    ).toEqual({ u1: 'replied', u2: 'queued' });
    expect(
      directReceipts([{ key: 'u', turn: turn('user') }], {}, true)
    ).toEqual({
      u: 'processing',
    });
  });
});
