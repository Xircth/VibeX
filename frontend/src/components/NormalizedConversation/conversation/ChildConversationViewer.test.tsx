import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import { ChildConversationViewer } from './ChildConversationViewer';

const { respondQuestion, useConversationTimeline } = vi.hoisted(() => ({
  respondQuestion: vi.fn(),
  useConversationTimeline: vi.fn(),
}));

vi.mock('@/features/conversation/useConversationTimeline', () => ({
  useConversationTimeline,
}));

vi.mock('../AstryxMarkdown', () => ({
  AstryxMarkdown: ({ value }: { value: string }) => (
    <div data-testid="markdown">{value}</div>
  ),
}));

function timelineMock(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'codex',
    timeline: [
      {
        key: 'user-1',
        phase: 'persisted',
        revision: 1n,
        turn: {
          id: 'turn-1:user',
          role: 'user',
          blocks: [{ type: 'text', text: 'Review the diff' }],
          timestamp: '2026-08-24T00:00:00.000Z',
        },
      },
      {
        key: 'assistant-1',
        phase: 'streaming',
        revision: 2n,
        turn: {
          id: 'turn-1:assistant',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Looking at the files…' }],
          timestamp: '2026-08-24T00:00:01.000Z',
        },
      },
    ],
    items: [],
    sideRows: [],
    loading: false,
    error: null,
    lastSequence: 2n,
    sessionModes: { current: null, modes: [] },
    sessionConfigOptions: [],
    sendOptimisticTurn: vi.fn(),
    removeOptimisticTurn: vi.fn(),
    refresh: vi.fn(),
    resetAndReload: vi.fn(),
    reconnectAndReload: vi.fn(),
    cancel: vi.fn(),
    respondPermission: vi.fn(),
    respondQuestion,
    ...overrides,
  };
}

describe('ChildConversationViewer', () => {
  beforeEach(() => {
    useConversationTimeline.mockReset();
    useConversationTimeline.mockImplementation(() => timelineMock());
  });

  it('streams the child conversation in the current session overlay', () => {
    const onClose = vi.fn();
    render(
      <div className="relative">
        <ChildConversationViewer
          conversationId="child-1"
          attempt={{ id: 'ws-1', container_ref: '/tmp/ws' } as never}
          task={null}
          onClose={onClose}
        />
      </div>
    );

    expect(useConversationTimeline).toHaveBeenCalledWith('child-1');
    const dialog = screen.getByTestId('child-conversation-viewer');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const backdrop = screen.getByTestId('child-conversation-backdrop');
    expect(backdrop.className).toContain('inset-0');
    expect(backdrop.className).toContain('backdrop-blur-md');
    expect(dialog.className).toContain('bg-[var(--surface-control)]');
    expect(screen.getByTestId('child-conversation-thread').className).toContain(
      'rounded-xl'
    );
    expect(screen.getByRole('heading', { name: 'Codex' })).toBeInTheDocument();
    expect(screen.getByText('Review the diff')).toBeInTheDocument();
    expect(screen.getByText('Looking at the files…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape without leaving the parent session', () => {
    const onClose = vi.fn();
    render(
      <ChildConversationViewer
        conversationId="child-1"
        attempt={{ id: 'ws-1', container_ref: null } as never}
        task={null}
        onClose={onClose}
      />
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('covers the conversation region so the composer does not leak through', () => {
    const region = document.createElement('div');
    region.className = 'right-panel-conversation-region relative';
    document.body.appendChild(region);
    const onClose = vi.fn();
    const view = render(
      <ChildConversationViewer
        conversationId="child-1"
        attempt={{ id: 'ws-1', container_ref: null } as never}
        task={null}
        onClose={onClose}
      />
    );

    expect(
      region.querySelector('[data-testid="child-conversation-backdrop"]')
    ).toBeInTheDocument();
    view.unmount();
    region.remove();
  });

  it('shows the delegated task as a user message when the child has no user turn', () => {
    useConversationTimeline.mockImplementation(() =>
      timelineMock({
        timeline: [
          {
            key: 'assistant-1',
            phase: 'settled',
            revision: 1n,
            turn: {
              id: 'turn-1:assistant',
              role: 'assistant',
              blocks: [{ type: 'text', text: '你好，我是 Codex' }],
              timestamp: '2026-08-24T00:00:01.000Z',
            },
          },
        ],
        items: [],
      })
    );

    render(
      <ChildConversationViewer
        conversationId="child-1"
        taskPreview="Please introduce yourself to the user in Chinese."
        attempt={{ id: 'ws-1', container_ref: null } as never}
        task={null}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByText('Please introduce yourself to the user in Chinese.')
    ).toBeInTheDocument();
    expect(screen.getByText('你好，我是 Codex')).toBeInTheDocument();
  });

  it('renders answered questions with the shared ask-question card', () => {
    useConversationTimeline.mockImplementation(() =>
      timelineMock({
        items: [
          {
            kind: 'side',
            revision: 3n,
            row: {
              row_id: 'q-1',
              revision: 3n,
              row: {
                kind: 'question_request',
                request: {
                  question_id: 'q-1',
                  prompt: 'Pick a tracker',
                  options: ['Local markdown'],
                  schema: {
                    'x-vibex-questions': [
                      {
                        id: 'tracker',
                        question: 'Pick a tracker',
                        options: [{ label: 'Local markdown' }],
                      },
                    ],
                  },
                },
                response: {
                  answer: 'Local markdown',
                  content: {
                    answers: [
                      { questionId: 'tracker', labels: ['Local markdown'] },
                    ],
                  },
                },
              },
            },
          },
        ],
      })
    );

    render(
      <ChildConversationViewer
        conversationId="child-1"
        attempt={{ id: 'ws-1', container_ref: null } as never}
        task={null}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByTestId('ask-question-tool-card')).toBeInTheDocument();
    expect(screen.getByText('Pick a tracker')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '提交回答' })
    ).not.toBeInTheDocument();
  });
});
