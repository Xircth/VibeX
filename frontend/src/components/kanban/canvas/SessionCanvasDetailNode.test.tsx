import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { SessionCanvasDetailNode } from './SessionCanvasDetailNode';

const resizeCard = vi.fn();
const resetCardSize = vi.fn();
const collapseCard = vi.fn();

const sessionsById = vi.hoisted(
  () =>
    new Map([
      [
        'session-1',
        {
          id: 'session-1',
          fullName: '展开会话',
          updatedAt: '2026-09-01T00:00:00.000Z',
          workspace: { id: 'ws' },
        } as KanbanProjectSessionRecord,
      ],
    ])
);

vi.mock('./CanvasViewContext', () => ({
  useSessionCanvasView: () => ({
    sessionsById,
    sessionsReady: true,
    expandCard: vi.fn(),
    collapseCard,
    removeCard: vi.fn(),
    zoomToCard: vi.fn(),
    previewResize: vi.fn(),
    resizeCard,
    resetCardSize,
    renameGroup: vi.fn(),
    toggleGroupShowAll: vi.fn(),
  }),
  useCanvasSession: (sessionId: string) => sessionsById.get(sessionId),
}));

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  NodeResizer: ({
    onResize,
    onResizeEnd,
    lineClassName,
    handleClassName,
  }: {
    onResize?: (
      event: unknown,
      params: { x: number; y: number; width: number; height: number }
    ) => void;
    onResizeEnd?: (
      event: unknown,
      params: { x: number; y: number; width: number; height: number }
    ) => void;
    lineClassName?: string;
    handleClassName?: string;
  }) => (
    <div>
      <span data-testid="resize-line-class">{lineClassName}</span>
      <span data-testid="resize-handle-class">{handleClassName}</span>
      <button
        type="button"
        onClick={() => onResize?.({}, { x: 8, y: 16, width: 700, height: 540 })}
      >
        resize
      </button>
      <button
        type="button"
        onClick={() =>
          onResizeEnd?.({}, { x: 8, y: 16, width: 700, height: 540 })
        }
      >
        resize-end
      </button>
    </div>
  ),
}));

vi.mock('@/components/kanban/session-hub/SessionMonitorCard', () => ({
  SessionMonitorCard: ({
    onZoom,
    selected,
  }: {
    onZoom?: (session: { id: string }) => void;
    selected?: boolean;
  }) => (
    <div>
      <span data-testid="window-selected">{String(!!selected)}</span>
      <button type="button" onClick={() => onZoom?.({ id: 'session-1' })}>
        reset-size
      </button>
    </div>
  ),
}));

describe('SessionCanvasDetailNode', () => {
  it('resizes from the handles and resets to the default window size', () => {
    render(
      <SessionCanvasDetailNode
        id="session-session-1"
        data={{ sessionId: 'session-1' }}
        selected
        type="sessionDetail"
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

    expect(screen.getByTestId('resize-line-class')).toHaveTextContent(
      'canvas-node-resize-line'
    );
    expect(screen.getByTestId('resize-handle-class')).toHaveTextContent(
      'canvas-node-resize-handle'
    );
    fireEvent.click(screen.getByText('resize'));
    fireEvent.click(screen.getByText('resize-end'));
    expect(resizeCard).toHaveBeenCalledWith('session-1', {
      x: 8,
      y: 16,
      width: 700,
      height: 540,
    });
    fireEvent.click(screen.getByText('reset-size'));
    expect(resetCardSize).toHaveBeenCalledWith('session-1');
  });

  it('forwards selected so the session window border can change', () => {
    const { rerender } = render(
      <SessionCanvasDetailNode
        id="session-session-1"
        data={{ sessionId: 'session-1' }}
        selected={false}
        type="sessionDetail"
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
    expect(screen.getByTestId('window-selected')).toHaveTextContent('false');
    rerender(
      <SessionCanvasDetailNode
        id="session-session-1"
        data={{ sessionId: 'session-1' }}
        selected
        type="sessionDetail"
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
    expect(screen.getByTestId('window-selected')).toHaveTextContent('true');
  });
});
