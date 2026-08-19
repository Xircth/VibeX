import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageTurnView } from './MessageTurnView';
import { STREAMING_ACTIVITY_VERBS } from './assistantStreamingActivity';

const conversationMessageStyles = readFileSync(
  resolve(process.cwd(), 'src/styles/conversation/conv-messages.css'),
  'utf8'
);

const {
  markdownMock,
  userMarkdownMock,
  openFilePreviewMock,
  openImagePreviewMock,
} = vi.hoisted(() => ({
  markdownMock: vi.fn(({ value }: { value: string }) => <div>{value}</div>),
  userMarkdownMock: vi.fn(({ value }: { value: string }) => <div>{value}</div>),
  openFilePreviewMock: vi.fn(),
  openImagePreviewMock: vi.fn(),
}));

function toolUseBlock(index: number, toolName: string, input: unknown) {
  return {
    type: 'tool_use' as const,
    tool_use_id: `tool-${index}`,
    tool_name: toolName,
    input_preview: JSON.stringify(input),
    meta: null,
  };
}

vi.mock('./AstryxMarkdown', () => ({
  AstryxMarkdown: markdownMock,
}));

vi.mock('./UserMessageMarkdown', () => ({
  UserMessageMarkdown: userMarkdownMock,
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  useOptionalPanelActionsContext: () => ({
    openFilePreview: openFilePreviewMock,
  }),
}));

vi.mock('@/hooks/useOpenImagePreview', () => ({
  useOpenImagePreview: () => openImagePreviewMock,
}));

const hideThinkingMock = vi.hoisted(() => ({ value: true }));

vi.mock('@/components/ConfigProvider', () => ({
  useOptionalUserSystem: () => ({
    config: { hide_model_thinking: hideThinkingMock.value },
  }),
}));

vi.mock('./ThinkingEntry', () => ({
  ThinkingEntry: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('./tools/ToolCardShell', () => ({
  ToolCardShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ToolCallResultDetail: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useToolCallResultDetail: () => false,
  getToolChatStatus: (status: { status: string }) =>
    status.status === 'created' ? 'running' : 'complete',
}));

vi.mock('./TimelinePlanCard', () => ({
  TimelinePlanCard: () => <div />,
}));

vi.mock('./DisplayConversationEntry', () => ({
  default: () => <div />,
}));

describe('MessageTurnView', () => {
  beforeEach(() => {
    hideThinkingMock.value = true;
    markdownMock.mockClear();
    userMarkdownMock.mockClear();
    openFilePreviewMock.mockClear();
    openImagePreviewMock.mockClear();
  });

  it('renders a user turn with the Astryx user-message semantics', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Inspect this project' }],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(
      screen.getByRole('article', { name: 'Message from user' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('user-message-bubble')).toHaveTextContent(
      'Inspect this project'
    );

    const bubbleRule =
      conversationMessageStyles.match(
        /\.vibex-user-message \.conv-user-bubble\s*\{[^}]+\}/u
      )?.[0] ?? '';
    expect(bubbleRule).toContain('font-size: 0.875rem;');
    expect(bubbleRule).toContain('line-height: 1.43;');
    expect(bubbleRule).toContain('background: var(--conv-user-bg);');
    expect(bubbleRule).toContain('color: var(--conv-user-text);');
    expect(userMarkdownMock).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'Inspect this project' }),
      undefined
    );
  });

  it('renders a cycling activity placeholder for an empty streaming assistant turn', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="streaming"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    const status = screen.getByRole('status', { name: 'AI 正在处理' });
    expect(status).toBeInTheDocument();
    const verb = STREAMING_ACTIVITY_VERBS.find((activity) =>
      status.textContent?.startsWith(`${activity}…`)
    );
    expect(verb).toBeDefined();
  });

  it('does not render a thinking placeholder for settled empty assistant turns', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('AI 正在思考中...')).not.toBeInTheDocument();
  });

  it('hides the streaming placeholder after cancel, failure, interrupt, or a turn error', () => {
    for (const phase of ['failed', 'cancelled', 'interrupted'] as const) {
      const { unmount } = render(
        <MessageTurnView
          turn={
            {
              id: 'turn-1:assistant',
              role: 'assistant',
              blocks: [],
              timestamp: '2026-06-14T00:00:00.000Z',
            } as never
          }
          phase={phase}
          attempt={{ id: 'attempt-1', container_ref: null } as never}
          task={null}
        />
      );
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      unmount();
    }

    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="streaming"
        hasTurnError
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders streaming assistant text through the markdown pipeline', () => {
    const value = '```ts\nconst answer = 42;\n```';

    const { container } = render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: value }],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="streaming"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(
      container.querySelector('.conv-streaming-markdown')
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('status', { name: 'AI 正在处理' })
    ).toBeInTheDocument();
    expect(markdownMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ value, isStreaming: true })
    );
  });

  it('uses the full markdown renderer once an assistant turn is settled', () => {
    const value = '```ts\nconst answer = 42;\n```';

    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: value }],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(markdownMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ value, isStreaming: false })
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('collapses command prelude text by default', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-command:assistant',
            role: 'assistant',
            blocks: [
              {
                type: 'text',
                text: 'Wall time: 1.7 seconds\nOutput:\nFinal answer',
              },
            ],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(screen.getByText('Final answer')).toBeInTheDocument();
    expect(screen.queryByText(/Wall time/)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Expand previous AI content' })
    );
    expect(screen.getByText(/Wall time: 1\.7 seconds/)).toBeInTheDocument();
  });

  it('hides thinking blocks when the hide-thinking setting is on', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [
              { type: 'thinking', text: 'private reasoning' },
              { type: 'text', text: 'visible answer' },
            ],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="streaming"
        attempt={
          {
            id: 'attempt-1',
            container_ref: null,
            session: { executor: 'claude_code' as const },
          } as never
        }
        task={null}
      />
    );

    expect(screen.queryByText('private reasoning')).not.toBeInTheDocument();
    expect(screen.getByText('visible answer')).toBeInTheDocument();
  });

  it('shows thinking blocks when the hide-thinking setting is off', () => {
    hideThinkingMock.value = false;

    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [
              { type: 'thinking', text: 'private reasoning' },
              { type: 'text', text: 'visible answer' },
            ],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="streaming"
        attempt={
          {
            id: 'attempt-1',
            container_ref: null,
            session: { executor: 'claude_code' as const },
          } as never
        }
        task={null}
        collapseProcess={false}
      />
    );

    expect(screen.getByText('private reasoning')).toBeInTheDocument();
    expect(screen.getByText('visible answer')).toBeInTheDocument();
  });

  it('hides thinking while preserving the streaming loading status', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [{ type: 'thinking', text: 'private reasoning' }],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="streaming"
        attempt={
          {
            id: 'attempt-1',
            container_ref: null,
            session: { executor: 'codex' as const },
          } as never
        }
        task={null}
      />
    );

    expect(screen.queryByText('private reasoning')).not.toBeInTheDocument();
    expect(
      screen.getByRole('status', { name: 'AI 正在处理' })
    ).toBeInTheDocument();
  });

  it('only renders edit controls when an editable retry callback is supplied', async () => {
    const onEditRetry = vi.fn().mockResolvedValue(true);
    const { rerender } = render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:user',
            role: 'user',
            blocks: [{ type: 'text', text: 'original prompt' }],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(
      screen.queryByRole('button', { name: '编辑并重发' })
    ).not.toBeInTheDocument();

    rerender(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:user',
            role: 'user',
            blocks: [{ type: 'text', text: 'original prompt' }],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        onEditRetry={onEditRetry}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑并重发' }));
    const editor = screen.getByRole('textbox', { name: '编辑用户消息' });
    fireEvent.change(editor, { target: { value: 'revised prompt' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() =>
      expect(onEditRetry).toHaveBeenCalledWith('revised prompt')
    );
  });

  it('renders user message actions as unframed icon-only buttons', () => {
    const actionButtonRule =
      conversationMessageStyles.match(
        /\.conv-user-action-btn\s*\{[^}]+\}/u
      )?.[0] ?? '';

    expect(actionButtonRule).not.toBe('');

    render(
      <>
        <style>{actionButtonRule}</style>
        <MessageTurnView
          turn={
            {
              id: 'turn-1:user',
              role: 'user',
              blocks: [{ type: 'text', text: 'original prompt' }],
              timestamp: '2026-06-14T00:00:00.000Z',
            } as never
          }
          attempt={{ id: 'attempt-1', container_ref: null } as never}
          task={null}
          onRetry={vi.fn()}
          onEditRetry={vi.fn().mockResolvedValue(true)}
        />
      </>
    );

    const actionButtons = [
      screen.getByRole('button', { name: '复制消息' }),
      screen.getByRole('button', { name: '重发' }),
      screen.getByRole('button', { name: '编辑并重发' }),
    ];

    expect(actionButtonRule).toContain('border: 0;');

    for (const button of actionButtons) {
      expect(button).toContainHTML('<svg');
      expect(button).toHaveTextContent('');
      expect(getComputedStyle(button).boxShadow).toBe('none');
    }
  });

  it('leaves interrupted status out of the timeline when it is docked above the composer', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-interrupted:user',
            role: 'user',
            blocks: [{ type: 'text', text: 'inspect the project' }],
            timestamp: '2026-07-22T00:00:00.000Z',
          } as never
        }
        phase="interrupted"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        showInterruptedNotice={false}
      />
    );

    expect(screen.getByText('inspect the project')).toBeInTheDocument();
    expect(screen.queryByText('因重启中断')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重发' })).toBeNull();
  });

  it('keeps one tool call inside the Astryx aggregate disclosure', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-single-tool:assistant',
            role: 'assistant',
            blocks: [toolUseBlock(1, 'bash', { command: 'git status' })],
            timestamp: '2026-08-08T00:00:00.000Z',
          } as never
        }
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        collapseProcess={false}
      />
    );

    expect(
      screen.getByRole('button', { name: /运行 1 个命令/ })
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('summarizes a mixed consecutive run by tool category', () => {
    const blocks = [
      ...Array.from({ length: 5 }, (_, index) =>
        toolUseBlock(index, 'bash', { command: `echo ${index}` })
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        toolUseBlock(10 + index, 'Read', { file_path: `src/${index}.ts` })
      ),
      ...Array.from({ length: 2 }, (_, index) =>
        toolUseBlock(20 + index, 'Edit', {
          file_path: `src/${index}.ts`,
          old_string: 'before',
          new_string: 'after',
        })
      ),
    ];

    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-mixed-tools:assistant',
            role: 'assistant',
            blocks,
            timestamp: '2026-08-08T00:00:00.000Z',
          } as never
        }
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        collapseProcess={false}
        workspacePath="/workspace/project"
      />
    );

    const disclosure = screen.getByRole('button', {
      name: /运行 5 个命令、已读 3 个文件、已改 2 个文件/,
    });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText('终端')).toHaveLength(5);
    expect(screen.getAllByText('0.ts')).not.toHaveLength(0);
    expect(screen.getAllByText('+1')).toHaveLength(2);
    expect(screen.getAllByText('-1')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'src/0.ts' })[0]);
    expect(openFilePreviewMock).toHaveBeenCalledWith(
      '/workspace/project/src/0.ts',
      { displayPath: 'src/0.ts', title: 'src/0.ts', location: null }
    );
  });

  it('expands images viewed by the agent and opens the configured preview', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-viewed-image:assistant',
            role: 'assistant',
            blocks: [
              {
                ...toolUseBlock(1, 'view_image', {
                  path: 'assets/logo.png',
                }),
                kind: 'read',
                images: [
                  {
                    data: 'AAAA',
                    mime_type: 'image/png',
                    uri: 'assets/logo.png',
                  },
                ],
              },
            ],
            timestamp: '2026-08-13T00:00:00.000Z',
          } as never
        }
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        collapseProcess={false}
        workspacePath="/workspace/project"
      />
    );

    const disclosure = screen.getByRole('button', {
      name: '已查看 1 张图像',
    });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(disclosure);
    const image = screen.getByRole('img', { name: 'assets/logo.png' });
    expect(image).toHaveAttribute('src', 'data:image/png;base64,AAAA');

    fireEvent.click(image);
    expect(openImagePreviewMock).toHaveBeenCalledWith({
      imageUrl: 'data:image/png;base64,AAAA',
      altText: 'assets/logo.png',
      fileName: 'logo.png',
    });
  });

  it('renders context compaction duration and resulting context length', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-compact:assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: '上下文已压缩' }],
            timestamp: '2026-08-08T00:00:00.000Z',
          } as never
        }
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        contextCompact={{
          status: 'success',
          durationMs: 1840,
          contextTokens: 42300,
        }}
      />
    );

    expect(screen.getByText('上下文已压缩')).toBeInTheDocument();
    expect(screen.getByText('1.8 秒')).toBeInTheDocument();
    expect(screen.getByText('42.3k tokens')).toBeInTheDocument();
    expect(markdownMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ value: '上下文已压缩' }),
      undefined
    );
  });
});
