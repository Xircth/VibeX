import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { SessionCanvasCardNode } from './SessionCanvasCardNode';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

const sessionsById = vi.hoisted(
  () =>
    new Map([
      [
        'session-1',
        {
          id: 'session-1',
          fullName: '画布卡片',
          updatedAt: '2026-09-01T00:00:00.000Z',
          branch: 'main',
          workspaceName: 'ws',
          isRunning: true,
          status: 'inprogress',
        } as KanbanProjectSessionRecord,
      ],
      [
        'session-review',
        {
          id: 'session-review',
          fullName: '待检查卡片',
          updatedAt: '2026-09-01T00:00:00.000Z',
          branch: 'main',
          workspaceName: 'ws',
          isRunning: false,
          status: 'inreview',
        } as KanbanProjectSessionRecord,
      ],
    ])
);

vi.mock('./CanvasViewContext', () => ({
  useSessionCanvasView: () => ({
    sessionsById,
    sessionsReady: true,
    expandCard: vi.fn(),
    collapseCard: vi.fn(),
    removeCard: vi.fn(),
    zoomToCard: vi.fn(),
    resizeCard: vi.fn(),
    resetCardSize: vi.fn(),
    renameGroup: vi.fn(),
    toggleGroupShowAll: vi.fn(),
  }),
  useCanvasSession: (sessionId: string) => sessionsById.get(sessionId),
}));

vi.mock('@/components/kanban/session-hub/SessionHubListItem', () => ({
  SessionHubListItem: ({
    displayMode,
    isSelected,
    marker,
    session,
  }: {
    displayMode?: string;
    isSelected?: boolean;
    marker: { bar: string } | null;
    session: { fullName: string };
  }) => (
    <div
      data-testid="status-session-card"
      data-display-mode={displayMode}
      data-selected={String(!!isSelected)}
      data-marker={marker?.bar ?? ''}
    >
      {session.fullName}
    </div>
  ),
}));

vi.mock('@/components/workspace-session-list/WorkspaceSessionList', () => ({
  WorkspaceSessionList: () => <div data-testid="workspace-session-list" />,
}));

describe('SessionCanvasCardNode', () => {
  it('keeps the status-column card chrome regardless of list grouping', () => {
    render(
      <SessionCanvasCardNode
        id="session-session-1"
        data={{ sessionId: 'session-1' }}
        selected={false}
        type="sessionCard"
        dragging={false}
        draggable
        selectable
        deletable
        zIndex={1}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    );

    expect(screen.getByTestId('status-session-card')).toHaveAttribute(
      'data-display-mode',
      'canvas'
    );
    expect(
      screen.queryByTestId('workspace-session-list')
    ).not.toBeInTheDocument();
  });

  it('does not wrap a selected card in an extra outer ring', () => {
    const { container } = render(
      <SessionCanvasCardNode
        id="session-session-1"
        data={{ sessionId: 'session-1' }}
        selected
        type="sessionCard"
        dragging={false}
        draggable
        selectable
        deletable
        zIndex={1}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    );

    expect(container.firstElementChild).not.toHaveClass('ring-2');
    expect(screen.getByTestId('status-session-card')).toHaveAttribute(
      'data-selected',
      'true'
    );
    expect(container.querySelector('.canvas-session-card')).toHaveClass(
      'is-selected',
      'is-running'
    );
  });

  it('marks an unviewed finished card for review breathing', () => {
    const { container } = render(
      <SessionCanvasCardNode
        id="session-session-review"
        data={{ sessionId: 'session-review' }}
        selected={false}
        type="sessionCard"
        dragging={false}
        draggable
        selectable
        deletable
        zIndex={1}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    );

    expect(container.querySelector('.canvas-session-card')).toHaveClass(
      'is-reviewing'
    );
    expect(container.querySelector('.canvas-session-card')).not.toHaveClass(
      'is-running'
    );
  });

  it('shows the open-window color marker on the card', () => {
    render(
      <SessionCanvasCardNode
        id="session-session-1"
        data={{ sessionId: 'session-1', slotIndex: 1 }}
        selected={false}
        type="sessionCard"
        dragging={false}
        draggable
        selectable
        deletable
        zIndex={1}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    );

    expect(screen.getByTestId('status-session-card')).toHaveAttribute(
      'data-marker',
      'session-marker-slot-2'
    );
  });
});
