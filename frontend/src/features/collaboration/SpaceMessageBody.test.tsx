import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const collaborationCall = vi.hoisted(() => vi.fn());
vi.mock('./collaborationApi', () => ({ collaborationCall }));

import { deriveMemberBotAvatar } from './MemberBotAvatar';
import {
  CollaborationMemberMentionContext,
  buildMemberMentionContextValue,
} from './MemberMentionChip';
import {
  SpaceMessageBody,
  messagePreviewText,
  parseCard,
} from './SpaceMessageBody';

const approval =
  '请求审批：合并 PR\n\n<card kind="approval" id="card-1">\n<action>\n合并 PR #42\n</action>\n<command>\ngit merge &lt;x&gt;\n</command>\n<reason>\n修复完成\n</reason>\n</card>';
const ask =
  '问你：用哪个分支？\n\n<card kind="ask" id="card-2">\n<question>\n用哪个分支？\n</question>\n<options>main|dev</options>\n</card>';

describe('SpaceMessageBody cards', () => {
  beforeEach(() => {
    collaborationCall.mockReset();
    collaborationCall.mockResolvedValue({ card: {} });
  });

  it('parses approval and ask cards', () => {
    expect(parseCard(approval)).toMatchObject({
      kind: 'approval',
      id: 'card-1',
    });
    expect(parseCard(approval)?.body).toContain('git merge <x>');
    expect(parseCard(ask)).toMatchObject({
      kind: 'ask',
      id: 'card-2',
      options: ['main', 'dev'],
    });
    expect(parseCard('plain text')).toBeNull();
  });

  it('resolves an approval card', async () => {
    render(<SpaceMessageBody fromYou={false} text={approval} />);
    expect(screen.queryByText(/<card/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    await waitFor(() =>
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'card.resolve',
        {
          cardId: 'card-1',
          decision: 'allow_once',
        }
      )
    );
    expect(
      await screen.findByTestId('collaboration-card-resolved')
    ).toHaveTextContent('已批准');
  });

  it('rejects an approval card', async () => {
    render(<SpaceMessageBody fromYou={false} text={approval} />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    await waitFor(() =>
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'card.resolve',
        {
          cardId: 'card-1',
          decision: 'deny',
        }
      )
    );
  });

  it('answers a question card by option or free text', async () => {
    const { unmount } = render(<SpaceMessageBody fromYou={false} text={ask} />);
    fireEvent.click(screen.getByRole('button', { name: 'dev' }));
    await waitFor(() =>
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'card.resolve',
        { cardId: 'card-2', answer: 'dev' }
      )
    );
    unmount();
    render(<SpaceMessageBody fromYou={false} text={ask} />);
    fireEvent.change(screen.getByLabelText('回答'), {
      target: { value: 'feature-x' },
    });
    fireEvent.click(screen.getByRole('button', { name: '回答' }));
    await waitFor(() =>
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'card.resolve',
        { cardId: 'card-2', answer: 'feature-x' }
      )
    );
  });
});

describe('messagePreviewText', () => {
  it('shows a label instead of raw card markup', () => {
    expect(messagePreviewText(approval)).toBe('审批请求');
    expect(messagePreviewText(ask)).toBe('提问：用哪个分支？');
    expect(messagePreviewText('hello\n  world')).toBe('hello world');
    expect(messagePreviewText('<card kind="approval" id="x"><action>')).toBe(
      '审批请求'
    );
  });
  it('wraps member messages in a collaboration-member-bubble container and renders overlapping delivery ticks', () => {
    const mentionCtx = buildMemberMentionContextValue([
      { nickname: '小A', avatar: deriveMemberBotAvatar('小A') },
    ]);
    const { rerender } = render(
      <CollaborationMemberMentionContext.Provider value={mentionCtx}>
        <SpaceMessageBody
          fromYou={false}
          text="你好 @小A"
          deliveryStatus={null}
        />
      </CollaborationMemberMentionContext.Provider>
    );
    const memberBubble = screen.getByTestId('collaboration-member-bubble');
    expect(memberBubble).toBeTruthy();
    expect(memberBubble.className).toContain('collaboration-member-bubble');
    const mentionChip = screen.getByTestId('collaboration-member-mention-chip-小A');
    expect(mentionChip).toBeTruthy();
    expect(mentionChip.textContent).toBe('小A');

    rerender(
      <SpaceMessageBody
        fromYou
        text="发送给 @小A"
        deliveryStatus="sent"
      />
    );
    const sentTicks = screen.getByTestId('collaboration-message-ticks');
    expect(sentTicks).toHaveAttribute('data-status', 'queued');
    expect(sentTicks.querySelectorAll('svg')).toHaveLength(1);

    rerender(
      <SpaceMessageBody
        fromYou
        text="发送给 @小A"
        deliveryStatus="delivered"
      />
    );
    const deliveredTicks = screen.getByTestId('collaboration-message-ticks');
    expect(deliveredTicks).toHaveAttribute('data-status', 'claimed');
    const svgs = deliveredTicks.querySelectorAll('svg');
    expect(svgs).toHaveLength(2);
    expect(svgs[0].getAttribute('width')).toBe('11');
    expect(svgs[0].getAttribute('height')).toBe('11');
    expect(deliveredTicks.closest('.conv-user-bubble')).toBeNull();
    expect(deliveredTicks.closest('.collaboration-bubble-outer-row')).not.toBeNull();
  });
});
