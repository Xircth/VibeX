import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import { MessageTurnView } from './MessageTurnView';

const { markdownMock } = vi.hoisted(() => ({
  markdownMock: vi.fn(({ value }: { value: string }) => <div>{value}</div>),
}));

vi.mock('./Markdown', () => ({
  Markdown: markdownMock,
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
            session: { executor: BaseCodingAgent.CLAUDE_CODE },
          } as never
        }
        task={null}
      />
    );

    expect(screen.queryByText('private reasoning')).not.toBeInTheDocument();
    expect(screen.getByText('visible answer')).toBeInTheDocument();
  });
});
