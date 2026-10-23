import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, expect, it, vi } from 'vitest';

import { GroupChat, type GroupSeat } from './GroupChat';
import { deriveMemberBotAvatar } from './MemberBotAvatar';
import { DirectComposer } from './MemberDirectChat';

const idle = { state: 'idle' as const, line: null, busyThreads: [], queued: 0 };

function seat(memberId: string, nickname: string): GroupSeat {
  return {
    memberId,
    nickname,
    conversationId: `c-${memberId}`,
    avatar: deriveMemberBotAvatar(memberId),
    presence: idle,
    busyElsewhere: null,
  };
}

function wrap(node: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <HotkeysProvider initiallyActiveScopes={['dialog']}>
        {node}
      </HotkeysProvider>
    </QueryClientProvider>
  );
}

function editor(): HTMLElement {
  const el = screen
    .getByTestId('session-composer-editor')
    .querySelector<HTMLElement>('[contenteditable="true"]');
  if (!el) throw new Error('composer editable not found');
  return el;
}

async function pickMember(
  user: ReturnType<typeof userEvent.setup>,
  name: string
) {
  await user.type(editor(), '@');
  await screen.findByTestId('composer-at-reference-menu');
  await user.click(screen.getByRole('option', { name: new RegExp(name) }));
}

function renderGroup() {
  const props = {
    groupName: '登录重构',
    seats: [seat('m1', 'Alex'), seat('m2', 'Blair')],
    messages: [],
    cardStatus: {},
    onSend: vi.fn(async () => undefined),
    onPreviewWake: vi.fn(async () => ({ willWake: 2, asleep: 1 })),
    onResolveCard: vi.fn(),
  };
  wrap(<GroupChat {...props} />);
  return props;
}

describe('GroupChat unified composer', () => {
  it('uses the session composer instead of a plain textarea', () => {
    renderGroup();
    const box = screen.getByTestId('collab-composer');
    expect(within(box).getByTestId('session-composer-editor')).toBeTruthy();
    expect(box.querySelector('textarea')).toBeNull();
  });

  it('inserts an atomic member chip and passes its id to send', async () => {
    const user = userEvent.setup();
    const props = renderGroup();
    await pickMember(user, 'Blair');
    await waitFor(() =>
      expect(editor().querySelector('.member-mention--composer')).toBeTruthy()
    );
    await user.type(editor(), '看下');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() =>
      expect(props.onSend).toHaveBeenCalledWith('@Blair 看下', ['Blair'])
    );
    expect(props.onPreviewWake).not.toHaveBeenCalled();
  });

  it('checks mentions at send time: no chip means the wake bar', async () => {
    const user = userEvent.setup();
    const props = renderGroup();
    await user.type(editor(), '大家看下{Enter}');
    expect(props.onPreviewWake).toHaveBeenCalledWith('大家看下');
    expect(await screen.findByTestId('collab-wake-confirm')).toBeTruthy();
    // Draft survives the composer's submit-clear while confirming.
    await waitFor(() => expect(editor().textContent).toContain('大家看下'));
    expect(props.onSend).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '仍然发送' }));
    expect(props.onSend).toHaveBeenCalledWith('大家看下', []);
  });

  it('clears the wake bar once the draft changes', async () => {
    const user = userEvent.setup();
    renderGroup();
    await user.type(editor(), '大家看下{Enter}');
    expect(await screen.findByTestId('collab-wake-confirm')).toBeTruthy();
    await user.type(editor(), '吧');
    expect(screen.queryByTestId('collab-wake-confirm')).toBeNull();
  });
});

describe('DirectComposer unified composer', () => {
  const members = [
    { id: 'm1', nickname: 'Alex', avatar: deriveMemberBotAvatar('m1') },
    { id: 'm2', nickname: 'Blair', avatar: deriveMemberBotAvatar('m2') },
  ];

  it('sends plain text on Enter and clears the draft', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    wrap(
      <DirectComposer memberName="Alex" members={members} onSend={onSend} />
    );
    expect(screen.getByRole('group', { name: '发消息给 Alex' })).toBeTruthy();
    await user.type(editor(), '你好{Enter}');
    expect(onSend).toHaveBeenCalledWith('你好');
    await waitFor(() => expect(editor().textContent?.trim() ?? '').toBe(''));
  });

  it('renders member chips and serializes them as @nickname', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    wrap(
      <DirectComposer memberName="Alex" members={members} onSend={onSend} />
    );
    await pickMember(user, 'Blair');
    await waitFor(() =>
      expect(editor().querySelector('.member-mention--composer')).toBeTruthy()
    );
    await user.type(editor(), '也看下');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(onSend).toHaveBeenCalledWith('@Blair 也看下');
  });

  it('does not send while sending', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    wrap(
      <DirectComposer
        memberName="Alex"
        sending
        members={members}
        onSend={onSend}
      />
    );
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(onSend).not.toHaveBeenCalled();
  });
});
