import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, expect, it, vi } from 'vitest';

import type { MessageTurn } from 'shared/types';

import { GroupChat, type GroupMessage } from './GroupChat';
import { deriveMemberBotAvatar } from './MemberBotAvatar';
import { MemberDirectChatLog } from './MemberDirectChat';
import { directChatNotices, type StreamMessage } from './threadModel';

const actor = (nick: string) =>
  `vibex://space/dm/member/${encodeURIComponent(nick)}`;

const wire: (StreamMessage & { created_at: string })[] = [
  {
    id: 'u-1',
    seq: 1,
    origin: 'user',
    created_at: '2026-10-24T01:00:00Z',
    envelope: {
      actor: 'vibex://space/dm/user',
      content: '@小A 去问小B',
      to: [actor('小A')],
    },
  },
  {
    id: 'a-1',
    seq: 2,
    origin: 'agent',
    created_at: '2026-10-24T01:01:00Z',
    envelope: {
      actor: actor('小A'),
      content: '接口好了吗',
      to: [actor('小B')],
    },
  },
  {
    id: 'b-1',
    seq: 3,
    origin: 'agent',
    in_reply_to: 'a-1',
    created_at: '2026-10-24T01:02:00Z',
    envelope: { actor: actor('小B'), content: '好了' },
  },
];

describe('directChatNotices', () => {
  it('derives sent_to / received_from from origin, to and in_reply_to', () => {
    expect(
      directChatNotices('小A', wire).map(({ kind, nickname }) => [
        kind,
        nickname,
      ])
    ).toEqual([
      ['sent_to', '小B'],
      ['received_from', '小B'],
    ]);
    expect(
      directChatNotices('小B', wire).map(({ kind, nickname }) => [
        kind,
        nickname,
      ])
    ).toEqual([['received_from', '小A']]);
    expect(directChatNotices('小C', wire)).toEqual([]);
  });

  it('ignores user-origin messages and dangling replies', () => {
    const userOnly = [{ ...wire[0], origin: 'user' }];
    expect(directChatNotices('小A', userOnly)).toEqual([]);
    const dangling = [{ ...wire[2], in_reply_to: 'gone' }];
    expect(directChatNotices('小A', dangling)).toEqual([]);
  });
});

function turn(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  timestamp: string
): MessageTurn {
  return {
    id,
    role,
    timestamp,
    blocks: [{ type: 'text', text }],
  } as MessageTurn;
}

describe('MemberDirectChatLog cross-DM lines', () => {
  it('renders chips in notice lines, interleaved by time', () => {
    render(
      <MemberDirectChatLog
        memberName="小A"
        avatar={null}
        receipts={{}}
        turns={[
          {
            key: 't1',
            turn: turn('t1', 'user', '去问小B', '2026-10-24T00:59:00Z'),
          },
          {
            key: 't2',
            turn: turn('t2', 'assistant', '小B 说好了', '2026-10-24T01:03:00Z'),
          },
        ]}
        notices={directChatNotices('小A', wire)}
        mentionCandidates={[
          { nickname: '小B', avatar: deriveMemberBotAvatar('m2') },
        ]}
      />
    );
    const lines = screen.getAllByTestId('collaboration-cross-chat-notice');
    expect(lines.map((line) => line.textContent?.replace(/\s+/g, ''))).toEqual([
      '已发消息给@小B',
      '已收到@小B的消息',
    ]);
    expect(within(lines[0]).getByText(/小B/)).toBeTruthy();
    const log = screen.getByTestId('collab-direct-log');
    const order = Array.from(
      log.querySelectorAll(
        '[data-testid="collaboration-cross-chat-notice"], article[data-from]'
      )
    ).map((el) =>
      el.tagName === 'ARTICLE' ? el.getAttribute('data-from') : 'notice'
    );
    expect(order).toEqual(['you', 'notice', 'notice', 'member']);
  });

  it('never renders cross-DM lines in group chats', () => {
    const messages: GroupMessage[] = wire.map((message) => ({
      ...message,
    })) as GroupMessage[];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HotkeysProvider initiallyActiveScopes={['dialog']}>
          <GroupChat
            groupName="g"
            seats={[]}
            messages={messages}
            cardStatus={{}}
            onSend={vi.fn()}
            onPreviewWake={vi.fn(async () => ({ willWake: 0, asleep: 0 }))}
            onResolveCard={vi.fn()}
          />
        </HotkeysProvider>
      </QueryClientProvider>
    );
    expect(screen.queryByTestId('collaboration-cross-chat-notice')).toBeNull();
  });
});

describe('review fixes: DM user chips, group user checks', () => {
  it('renders MemberMention chips in the user message of a direct chat', () => {
    render(
      <MemberDirectChatLog
        memberName="小A"
        avatar={null}
        receipts={{}}
        turns={[
          {
            key: 'u1',
            turn: turn(
              'u1',
              'user',
              '去问下 @小B 接口好了没',
              '2026-10-24T01:00:00Z'
            ),
          },
        ]}
        mentionCandidates={[
          { nickname: '小B', avatar: deriveMemberBotAvatar('m2') },
        ]}
      />
    );
    const you = document.querySelector('article[data-from="you"]')!;
    const chip = within(you as HTMLElement).getByTestId('member-mention');
    expect(chip.getAttribute('data-member-mention')).toBe('小B');
    expect(you.textContent?.replace(/\s+/g, '')).toBe('去问下@小B接口好了没');
  });

  it('shows a receipt check on user bubbles even before any receipt', () => {
    const userMessage = {
      id: 'g1',
      seq: 1,
      origin: 'user',
      envelope: {
        actor: 'vibex://space/g/user',
        content: '@小A 请看 diff',
        to: [actor('小A')],
      },
    } as GroupMessage;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HotkeysProvider initiallyActiveScopes={['dialog']}>
          <GroupChat
            groupName="g"
            seats={[]}
            messages={[userMessage, { ...wire[1], seq: 2 } as GroupMessage]}
            cardStatus={{}}
            onSend={vi.fn()}
            onPreviewWake={vi.fn(async () => ({ willWake: 0, asleep: 0 }))}
            onResolveCard={vi.fn()}
          />
        </HotkeysProvider>
      </QueryClientProvider>
    );
    const checks = screen.getAllByTestId('collaboration-receipt-check');
    expect(checks).toHaveLength(1);
    expect(checks[0].getAttribute('data-state')).toBe('sent');
    expect(checks[0].closest('article[data-from]')?.getAttribute('data-from')).toBe('you');
  });
});
