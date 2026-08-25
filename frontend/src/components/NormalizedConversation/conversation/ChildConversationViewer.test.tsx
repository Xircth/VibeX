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
    expect(screen.getByTestId('child-conversation-viewer')).toBeInTheDocument();
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
});
