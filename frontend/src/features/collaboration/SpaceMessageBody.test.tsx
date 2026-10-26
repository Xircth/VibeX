import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  bubbleText,
  messagePreviewText,
  parseCard,
} from './SpaceMessageBody';

const approval =
  '请求审批：合并 PR\n\n<card kind="approval" id="card-1">\n<action>\n合并 PR #42\n</action>\n<command>\ngit merge &lt;x&gt;\n</command>\n<reason>\n修复完成\n</reason>\n</card>';
const ask =
  '问你：用哪个分支？\n\n<card kind="ask" id="card-2">\n<question>\n用哪个分支？\n</question>\n<options>main|dev</options>\n</card>';
const askUserQuestion = `问你：用哪个方案？

<card kind="ask" id="card-3">
<question>
用哪个方案？
</question>
<options>Patch (Recommended)|Rewrite</options>
<questions>
[{"question":"用哪个方案？","header":"方案","multiSelect":false,"options":[{"label":"Patch (Recommended)","description":"小改。"},{"label":"Rewrite","description":"重写。"}]}]
</questions>
</card>`;

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
    expect(parseCard(askUserQuestion)).toMatchObject({
      kind: 'ask',
      id: 'card-3',
    });
    expect(parseCard(askUserQuestion)?.questions).toEqual([
      {
        question: '用哪个方案？',
        header: '方案',
        multiSelect: false,
        options: [
          { label: 'Patch (Recommended)', description: '小改。' },
          { label: 'Rewrite', description: '重写。' },
        ],
      },
    ]);
  });

  it('renders ask_user_question cards with the session question UI', async () => {
    render(<SpaceMessageBody fromYou={false} text={askUserQuestion} />);
    expect(await screen.findByTestId('agent-question-card')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await waitFor(() =>
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'card.resolve',
        expect.objectContaining({
          cardId: 'card-3',
          answer: expect.stringContaining('Patch'),
        })
      )
    );
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
    const mentionChip = screen.getByTestId(
      'collaboration-member-mention-chip-小A'
    );
    expect(mentionChip).toBeTruthy();
    expect(mentionChip.textContent).toBe('小A');

    rerender(
      <SpaceMessageBody fromYou text="发送给 @小A" deliveryStatus="sent" />
    );
    const sentTicks = screen.getByTestId('collaboration-message-ticks');
    expect(sentTicks).toHaveAttribute('data-status', 'queued');
    expect(sentTicks.querySelectorAll('svg')).toHaveLength(1);

    rerender(
      <SpaceMessageBody fromYou text="发送给 @小A" deliveryStatus="delivered" />
    );
    const deliveredTicks = screen.getByTestId('collaboration-message-ticks');
    expect(deliveredTicks).toHaveAttribute('data-status', 'claimed');
    const svgs = deliveredTicks.querySelectorAll('svg');
    expect(svgs).toHaveLength(2);
    expect(svgs[0].getAttribute('width')).toBe('11');
    expect(svgs[0].getAttribute('height')).toBe('11');
    expect(deliveredTicks.closest('.conv-user-bubble')).toBeNull();
    const userRow = deliveredTicks.closest(
      '.collaboration-bubble-outer-row--user'
    );
    expect(userRow).not.toBeNull();
    expect(userRow?.querySelector('.conv-user-bubble')).not.toBeNull();
    expect(
      deliveredTicks.compareDocumentPosition(
        userRow!.querySelector('.conv-user-bubble') as Node
      ) & Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy();
  });

  it('nests reaction emojis on the bubble', () => {
    render(
      <SpaceMessageBody
        fromYou={false}
        text="你好"
        reactions={[
          { emoji: '😄', actor: 'user' },
          { emoji: '🎉', actor: '小A' },
        ]}
      />
    );
    expect(screen.getByTestId('collaboration-bubble-reaction')).toHaveTextContent(
      '😄🎉'
    );
  });

  it('renders markdown images and live HTML previews in member bubbles', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SpaceMessageBody
          fromYou={false}
          text={
            '![截图](https://example.com/shot.png)\n\n```html\n<p>hi</p>\n```'
          }
        />
      </QueryClientProvider>
    );
    const image = screen.getByRole('img', { name: '截图' });
    expect(image).toHaveAttribute('src', 'https://example.com/shot.png');
    const frame = screen.getByTitle('HTML 预览');
    expect(frame).toHaveAttribute(
      'srcdoc',
      expect.stringContaining('<p>hi</p>')
    );
  });
});

describe('bubbleText', () => {
  it('shows content when summary differs, without prepending the title', () => {
    expect(
      bubbleText({
        summary: '用户让我分析项目',
        content: '我已经完成了项目完整分析，是否需要给出完整分析报告？',
      })
    ).toBe('我已经完成了项目完整分析，是否需要给出完整分析报告？');
  });

  it('falls back to summary when content is empty', () => {
    expect(bubbleText({ summary: '阶段进展', content: '' })).toBe('阶段进展');
    expect(bubbleText({ summary: '阶段进展' })).toBe('阶段进展');
  });

  it('returns content when there is no distinct summary', () => {
    expect(bubbleText({ content: '好的，我正在查看项目中' })).toBe(
      '好的，我正在查看项目中'
    );
    expect(
      bubbleText({
        summary: '好的，我正在查看项目中',
        content: '好的，我正在查看项目中',
      })
    ).toBe('好的，我正在查看项目中');
  });
});
