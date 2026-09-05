import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionCanvasGroupNode } from './SessionCanvasGroupNode';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  NodeResizer: () => null,
}));

vi.mock('./CanvasViewContext', () => ({
  useSessionCanvasView: () => ({
    renameGroup: vi.fn(),
    toggleGroupShowAll: vi.fn(),
    previewGroupResize: vi.fn(),
    beginGroupResize: vi.fn(),
    resizeGroup: vi.fn(),
  }),
}));

describe('SessionCanvasGroupNode', () => {
  it('uses a compact header with a larger black group name', () => {
    const { container } = render(
      <SessionCanvasGroupNode
        id="group-1"
        data={{
          instanceId: 'g1',
          name: '分组',
          index: 1,
          count: 2,
          overflow: 0,
          showAll: false,
          collapsed: false,
          isRunning: true,
        }}
        selected
        type="sessionGroup"
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

    const name = screen.getByRole('button', { name: '分组' });
    expect(name).toHaveClass('text-[14px]', 'text-[var(--text-strong)]');
    expect(name).not.toHaveClass('nodrag');
    expect(name.parentElement).toHaveStyle({ height: '32px' });
    expect(container.querySelector('.canvas-session-group')).toHaveClass(
      'is-selected',
      'is-running',
      'cursor-grab'
    );
  });

  it('marks a group for review breathing when a child needs review', () => {
    const { container } = render(
      <SessionCanvasGroupNode
        id="group-1"
        data={{
          instanceId: 'g1',
          name: '分组',
          index: 1,
          count: 2,
          overflow: 0,
          showAll: false,
          collapsed: false,
          isReviewing: true,
        }}
        selected={false}
        type="sessionGroup"
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

    expect(container.querySelector('.canvas-session-group')).toHaveClass(
      'is-reviewing'
    );
  });
});
