import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { renderWithQueryClient as render } from '@/test/QueryClientHarness';
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

  it('uses the unified unclipped .canvas-session-card > .session-hub-card structure for panel minimized nodes', () => {
    const { container } = render(
      <SessionCanvasCardNode
        id="panel-space-1"
        data={{
          sessionId: '',
          instanceId: 'panel-space-1',
          panelId: 'collaboration-space',
          panelComponent: 'collaboration-space',
          panelTitle: 'Master',
          panelParams: { spaceId: 'collaboration-space' },
        }}
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

    const outerWrapper = container.querySelector('.canvas-session-card');
    const innerCard = screen.getByTestId(
      'canvas-panel-card-collaboration-space'
    );
    expect(outerWrapper).not.toBeNull();
    expect(outerWrapper).toHaveClass('is-selected');
    expect(outerWrapper).not.toHaveClass('overflow-hidden');
    expect(outerWrapper?.contains(innerCard)).toBe(true);
    expect(innerCard).toHaveClass('session-hub-card', 'is-selected');
    expect(innerCard).not.toHaveClass('flex-col');
    expect(screen.getByText('协作空间')).toBeInTheDocument();
    expect(screen.getByText('群聊空间')).toBeInTheDocument();
  });

  it('replaces raw internal IDs and full OS paths with clean category and context metadata on panel minimized nodes', () => {
    const { rerender } = render(
      <SessionCanvasCardNode
        id="panel-space-uuid"
        data={{
          sessionId: '',
          instanceId: 'panel-space-uuid',
          panelId: 'collaboration-space:signed:49011335-c8f1-47cf',
          panelComponent: 'collaboration-space',
          panelTitle: 'Master',
          panelParams: {
            spaceId: 'signed:49011335-c8f1-47cf-9ca3-1a2a57',
            targetType: 'direct',
          },
        }}
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

    expect(screen.getByText('Master')).toBeInTheDocument();
    expect(screen.getByText('协作空间')).toBeInTheDocument();
    expect(screen.getByText('私聊会话')).toBeInTheDocument();
    expect(screen.queryByText(/signed:49011335/)).not.toBeInTheDocument();

    rerender(
      <SessionCanvasCardNode
        id="panel-member"
        data={{
          sessionId: '',
          instanceId: 'panel-member',
          panelId: 'member-session:bot-1',
          panelComponent: 'member-session',
          panelTitle: 'Master',
          panelParams: {},
        }}
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

    expect(screen.getByText('Bot 助手')).toBeInTheDocument();
    expect(screen.getByText('专属会话')).toBeInTheDocument();
    expect(screen.queryByText('member-session')).not.toBeInTheDocument();

    rerender(
      <SessionCanvasCardNode
        id="panel-file"
        data={{
          sessionId: '',
          instanceId: 'panel-file',
          panelId: 'file:readme',
          panelComponent: 'preview',
          panelTitle: 'README.md',
          panelParams: {
            filePath: 'C:\\Users\\18190\\Documents\\projects\\StallerLab\\README.md',
          },
        }}
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

    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('预览')).toBeInTheDocument();
    expect(screen.getByText('StallerLab')).toBeInTheDocument();
  });
});
