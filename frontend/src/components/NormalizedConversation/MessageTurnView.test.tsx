import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageTurnView } from './MessageTurnView';

const conversationMessageStyles = readFileSync(
  resolve(process.cwd(), 'src/styles/conversation/conv-messages.css'),
  'utf8'
);

const { markdownMock } = vi.hoisted(() => ({
  markdownMock: vi.fn(({ value }: { value: string }) => <div>{value}</div>),
}));

vi.mock('./AstryxMarkdown', () => ({
  AstryxMarkdown: markdownMock,
}));

vi.mock('./ThinkingEntry', () => ({
  ThinkingEntry: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('./tools/ToolCardShell', () => ({
  ToolCardShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('./TimelinePlanCard', () => ({
  TimelinePlanCard: () => <div />,
}));

vi.mock('./DisplayConversationEntry', () => ({
  default: () => <div />,
}));

describe('MessageTurnView', () => {
  beforeEach(() => {
    markdownMock.mockClear();
  });

  it('renders a thinking placeholder for an empty streaming assistant turn', () => {
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

    expect(
      screen.getByRole('status', { name: 'AI 正在思考中...' })
    ).toBeInTheDocument();
    expect(screen.getByText('AI 正在思考中...')).toBeInTheDocument();
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
      screen.getByRole('status', { name: 'AI 正在输出...' })
    ).toBeInTheDocument();
    expect(markdownMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ value })
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
      expect.objectContaining({ value })
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

  it('hides thinking blocks for ClaudeCode assistant turns', () => {
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

  it('hides Codex thinking while preserving the streaming loading status', () => {
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
      screen.getByRole('status', { name: 'AI 正在思考中...' })
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
});
