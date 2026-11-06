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
  parseHandoff,
} from './SpaceMessageBody';

const approval =
  '请求审批：合并 PR\n\n<card kind="approval" id="card-1">\n<action>\n合并 PR #42\n</action>\n<command>\ngit merge &lt;x&gt;\n</command>\n<reason>\n修复完成\n</reason>\n</card>';
const ask =
  '问你：用哪个分支？\n\n<card kind="ask" id="card-2">\n<question>\n用哪个分支？\n</question>\n<options>main|dev</options>\n</card>';
const handoffXml = `<handoff id="h-1" depth="1">
<done>
已写完接口草稿
</done>
<inputs_constraints>
不要改数据库
</inputs_constraints>
<ask>
@小B 请补测试
</ask>
</handoff>`;

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

  it('renders ask_user_question cards as a standalone message container without wrapping inside a member bubble', async () => {
    render(<SpaceMessageBody fromYou={false} text={askUserQuestion} />);
    const questionCard = await screen.findByTestId('agent-question-card');
    expect(questionCard).toBeTruthy();
    const standaloneContainer = screen.getByTestId(
      'collaboration-question-card-container'
    );
    expect(standaloneContainer).toContainElement(questionCard);
    expect(questionCard.closest('.conv-assistant-msg')).toBeNull();
    expect(questionCard.closest('.collaboration-member-bubble')).toBeNull();
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

  it('splits preceding prose into its own bubble and renders the question card standalone below it', async () => {
    render(
      <SpaceMessageBody
        fromYou={false}
        text={`请先确认以下配置：\n\n${askUserQuestion}`}
      />
    );
    const questionCard = await screen.findByTestId('agent-question-card');
    expect(
      screen.getByText('请先确认以下配置：').closest('.conv-assistant-msg')
    ).toBeTruthy();
    expect(questionCard.closest('.conv-assistant-msg')).toBeNull();
    expect(questionCard.closest('.collaboration-member-bubble')).toBeNull();
    expect(
      screen.getByTestId('collaboration-question-card-container')
    ).toContainElement(questionCard);
  });

  it('resolves an approval card', async () => {
    render(<SpaceMessageBody fromYou={false} text={approval} />);
    expect(screen.queryByText(/<card/)).toBeNull();
    expect(screen.getByRole('heading', { name: '权限申请' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
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

  it('parses and hides legacy handoff XML', () => {
    expect(parseHandoff(handoffXml)).toMatchObject({
      id: 'h-1',
      depth: '1',
      done: '已写完接口草稿',
      inputsConstraints: '不要改数据库',
      ask: '@小B 请补测试',
    });
    expect(parseHandoff('plain @小B 请补测试')).toBeNull();
    expect(messagePreviewText(handoffXml)).toBe('请继续：@小B 请补测试');
    render(<SpaceMessageBody fromYou={false} text={handoffXml} />);
    expect(screen.queryByText(/<handoff/)).toBeNull();
    expect(screen.queryByText(/<\/ask>/)).toBeNull();
    expect(screen.getByTestId('collaboration-handoff')).toHaveTextContent(
      '请补测试'
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

  it('renders resolved status when the card record was already resolved in session', () => {
    render(
      <SpaceMessageBody
        fromYou={false}
        text={ask}
        cards={[
          {
            id: 'card-2',
            kind: 'ask',
            status: 'resolved',
            resolution: { answer: 'dev' },
          },
        ]}
      />
    );
    expect(screen.getByTestId('collaboration-card-resolved')).toHaveTextContent(
      '已回答：dev'
    );
  });

  it('keeps the question card visible and formats JSON answers when an ask_user_question card is resolved', () => {
    render(
      <SpaceMessageBody
        fromYou={false}
        text={askUserQuestion}
        cards={[
          {
            id: 'card-3',
            kind: 'ask',
            status: 'resolved',
            resolution: {
              answer: '{"questionId":"question-1","labels":["仅会话界面可见"]}',
            },
          },
        ]}
      />
    );
    expect(screen.getByTestId('ask-question-tool-card')).toBeInTheDocument();
    expect(screen.getByTestId('ask-question-title')).toHaveTextContent(
      '用哪个方案？'
    );
    expect(screen.getByTestId('collaboration-card-resolved')).toHaveTextContent(
      '已回答：仅会话界面可见'
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
    expect(
      screen.getByTestId('collaboration-bubble-reaction')
    ).toHaveTextContent('😄🎉');
  });

  it('renders markdown images and splits live HTML previews into standalone blocks with a right-click context menu', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SpaceMessageBody
          fromYou={false}
          text={
            '![截图](https://example.com/shot.png)\n\n```html\n<!DOCTYPE html><html><head><title>Liquid Glass</title></head><body><p>hi</p></body></html>\n```\n\n后半段说明文字'
          }
        />
      </QueryClientProvider>
    );
    const image = screen.getByRole('img', { name: '截图' });
    expect(image).toHaveAttribute('src', 'https://example.com/shot.png');
    const standaloneBlock = screen.getByTestId(
      'collaboration-standalone-html-block'
    );
    expect(standaloneBlock.closest('.collaboration-member-bubble')).toBeNull();
    const previewContainer = screen.getByTestId('standalone-html-preview');
    expect(
      previewContainer.querySelector('.conv-md-html-preview-bar')
    ).toBeNull();
    expect(screen.queryByTestId('html-preview-context-menu')).toBeNull();

    const frame = screen.getByTitle('HTML 预览');
    expect(frame).toHaveAttribute(
      'srcdoc',
      expect.stringContaining('<p>hi</p>')
    );

    fireEvent.contextMenu(previewContainer, { clientX: 48, clientY: 48 });
    const menu = screen.getByTestId('html-preview-context-menu');
    expect(menu).toBeTruthy();
    expect(screen.getByTestId('html-preview-open-tab')).toHaveTextContent(
      '在标签页打开'
    );
    expect(screen.getByTestId('html-preview-copy-path')).toHaveTextContent(
      '复制绝对路径'
    );
    const expandItem = screen.getByTestId('html-preview-toggle-expand');
    expect(expandItem).toHaveTextContent('展开');

    fireEvent.click(expandItem);
    expect(screen.queryByTestId('html-preview-context-menu')).toBeNull();
    expect(previewContainer).toHaveAttribute('data-expanded', 'true');

    fireEvent.contextMenu(previewContainer, { clientX: 48, clientY: 48 });
    expect(screen.getByTestId('html-preview-toggle-expand')).toHaveTextContent(
      '收起'
    );

    expect(
      screen.getByTestId('collaboration-member-bubble-2')
    ).toHaveTextContent('后半段说明文字');
  });

  it('caps overly long user and member messages with a lower-half fade, expands on 展开全部, and collapses back on 收起全部', () => {
    const longText = Array.from(
      { length: 14 },
      (_, idx) =>
        `第 ${idx + 1} 行：这是一段用于测试单条消息最大高度限制与渐隐展开胶囊的长文本内容。`
    ).join('\n');

    const { unmount } = render(
      <SpaceMessageBody fromYou={false} text={longText} />
    );
    const memberCollapsible = screen.getByTestId(
      'collaboration-bubble-collapsible'
    );
    expect(memberCollapsible).toHaveAttribute('data-collapsed', 'true');
    expect(
      screen.getByTestId('collaboration-bubble-collapsible-fade')
    ).toBeTruthy();
    const memberExpandPill = screen.getByTestId(
      'collaboration-bubble-expand-pill'
    );
    expect(memberExpandPill).toHaveTextContent('展开全部');

    fireEvent.click(memberExpandPill);
    expect(memberCollapsible).toHaveAttribute('data-collapsed', 'false');
    expect(screen.queryByTestId('collaboration-bubble-expand-pill')).toBeNull();
    const memberCollapsePill = screen.getByTestId(
      'collaboration-bubble-collapse-pill'
    );
    expect(memberCollapsePill).toHaveTextContent('收起全部');

    fireEvent.click(memberCollapsePill);
    expect(memberCollapsible).toHaveAttribute('data-collapsed', 'true');
    expect(
      screen.getByTestId('collaboration-bubble-expand-pill')
    ).toHaveTextContent('展开全部');
    unmount();

    render(<SpaceMessageBody fromYou text={longText} />);
    const userCollapsible = screen.getByTestId(
      'collaboration-bubble-collapsible'
    );
    expect(userCollapsible).toHaveAttribute('data-collapsed', 'true');
    const userExpandPill = screen.getByTestId(
      'collaboration-bubble-expand-pill'
    );
    expect(userExpandPill).toHaveTextContent('展开全部');

    fireEvent.click(userExpandPill);
    expect(userCollapsible).toHaveAttribute('data-collapsed', 'false');
    expect(screen.queryByTestId('collaboration-bubble-expand-pill')).toBeNull();
    const userCollapsePill = screen.getByTestId(
      'collaboration-bubble-collapse-pill'
    );
    expect(userCollapsePill).toHaveTextContent('收起全部');

    fireEvent.click(userCollapsePill);
    expect(userCollapsible).toHaveAttribute('data-collapsed', 'true');
  });

  it('does not collapse short messages', () => {
    render(<SpaceMessageBody fromYou={false} text="短消息无需折叠" />);
    const collapsible = screen.getByTestId('collaboration-bubble-collapsible');
    expect(collapsible).toHaveAttribute('data-collapsed', 'false');
    expect(screen.queryByTestId('collaboration-bubble-expand-pill')).toBeNull();
  });

  it('defaults overflowing messages to expanded while streaming and collapses them once streaming finishes, without bouncing when manually expanded', () => {
    const longText = Array.from(
      { length: 14 },
      (_, idx) =>
        `第 ${idx + 1} 行：这是一段正在流式输出的长文本内容，用于在流式输出期间保持默认展开。`
    ).join('\n');

    const { rerender } = render(
      <SpaceMessageBody fromYou={false} text={longText} streaming />
    );
    const collapsible = screen.getByTestId('collaboration-bubble-collapsible');
    expect(collapsible).toHaveAttribute('data-collapsed', 'false');
    expect(screen.queryByTestId('collaboration-bubble-expand-pill')).toBeNull();
    expect(
      screen.queryByTestId('collaboration-bubble-collapse-pill')
    ).toBeNull();

    // Streaming appends more tokens — still expanded
    const longerText = `${longText}\n第 15 行：继续追加流式输出内容。`;
    rerender(<SpaceMessageBody fromYou={false} text={longerText} streaming />);
    expect(collapsible).toHaveAttribute('data-collapsed', 'false');

    // Streaming completes — automatically collapses
    rerender(
      <SpaceMessageBody fromYou={false} text={longerText} streaming={false} />
    );
    expect(collapsible).toHaveAttribute('data-collapsed', 'true');
    const expandPill = screen.getByTestId('collaboration-bubble-expand-pill');
    expect(expandPill).toHaveTextContent('展开全部');

    // Manual expand stays expanded even if text updates
    fireEvent.click(expandPill);
    expect(collapsible).toHaveAttribute('data-collapsed', 'false');
    rerender(
      <SpaceMessageBody
        fromYou={false}
        text={`${longerText}\n补充内容`}
        streaming={false}
      />
    );
    expect(collapsible).toHaveAttribute('data-collapsed', 'false');
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
