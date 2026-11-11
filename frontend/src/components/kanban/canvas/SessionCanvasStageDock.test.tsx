import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { CARD_HEIGHT, CARD_WIDTH } from './canvasModel';
import type { SessionCanvasBoardEntry } from './canvasStorage';
import { SessionCanvasHistoryDock } from './SessionCanvasHistoryDock';
import { SessionCanvasViewportPanel } from './SessionCanvasViewportPanel';

vi.mock('@xyflow/react', () => ({
  Panel: ({
    children,
    position,
    ...rest
  }: {
    children: React.ReactNode;
    position: string;
    [key: string]: unknown;
  }) => (
    <div data-testid="rf-panel" data-panel-position={position} {...rest}>
      {children}
    </div>
  ),
  MiniMap: () => <div data-testid="rf-minimap" />,
  useReactFlow: () => ({
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomTo: vi.fn(),
  }),
  useStore: (selector: (s: unknown) => unknown) =>
    selector({
      transform: [0, 0, 1],
      minZoom: 0.1,
      maxZoom: 2,
    }),
}));

describe('SessionCanvasStageDock & ViewportPanel', () => {
  const sampleCanvases: SessionCanvasBoardEntry[] = [
    {
      id: 'default',
      name: '主画布',
      createdAt: 1,
      updatedAt: 1,
      document: {
        nodes: [
          {
            id: 'node-1',
            kind: 'session',
            sessionId: 'session-1',
            parentId: null,
            name: '',
            createdAt: 0,
            showAll: false,
            x: 20,
            y: 40,
            width: CARD_WIDTH,
            height: CARD_HEIGHT,
            expanded: false,
          },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
        listCollapsed: false,
        minimapVisible: true,
      },
    },
    {
      id: 'board-2',
      name: '调试画布',
      createdAt: 2,
      updatedAt: 2,
      document: {
        nodes: [],
        viewport: null,
        listCollapsed: false,
        minimapVisible: true,
      },
    },
    {
      id: 'board-3',
      name: '',
      createdAt: 3,
      updatedAt: 3,
      document: {
        nodes: [],
        viewport: null,
        listCollapsed: false,
        minimapVisible: true,
      },
    },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      }
    );
  });

  it('floats non-active canvases horizontally without an outer container, places inverted standalone New Canvas button below the canvas list, and applies Stage Manager 3D inward fold', async () => {
    const user = userEvent.setup();
    const onSelectCanvas = vi.fn();
    const onCreateCanvas = vi.fn();
    const onRenameCanvas = vi.fn();
    const onDeleteCanvas = vi.fn();

    const { rerender } = render(
      <SessionCanvasViewportPanel
        mapVisible
        position="bottom-left"
        canvases={sampleCanvases}
        activeCanvasId="default"
        onSelectCanvas={onSelectCanvas}
        onCreateCanvas={onCreateCanvas}
        onRenameCanvas={onRenameCanvas}
        onDeleteCanvas={onDeleteCanvas}
        onMapVisibleChange={vi.fn()}
      />
    );

    const panel = screen.getByTestId('rf-panel');
    expect(panel).toHaveAttribute('data-panel-position', 'bottom-left');

    // Stage dock is closed by default
    expect(screen.queryByTestId('canvas-stage-dock')).not.toBeInTheDocument();

    const trigger = screen.getByTestId('canvas-stage-dock-trigger');
    const minimapBtn = screen.getByRole('button', { name: '隐藏小地图' });
    expect(
      trigger.compareDocumentPosition(minimapBtn) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    await user.click(trigger);

    const stageDock = screen.getByTestId('canvas-stage-dock');
    expect(stageDock).toBeInTheDocument();
    // Outer container has no card border/background box and stacks list above button
    expect(stageDock.className).not.toContain('border-border');
    expect(stageDock.className).not.toContain('surface-card');
    expect(stageDock).toHaveClass('flex-col', 'items-start');

    // Active canvas ('default' / '主画布') is excluded from the displayed list
    expect(
      screen.queryByTestId('canvas-stage-item-default')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('主画布')).not.toBeInTheDocument();

    // Non-active canvases are directly displayed, preserving original fallback numbering ('画布 3')
    const board2Card = screen.getByTestId('canvas-stage-item-board-2');
    const board3Card = screen.getByTestId('canvas-stage-item-board-3');
    expect(board2Card).toBeInTheDocument();
    expect(board3Card).toBeInTheDocument();
    expect(screen.getByText('画布 3')).toBeInTheDocument();

    // Standalone New Canvas button is placed below the canvas list with inverted background
    const createBtn = screen.getByTestId('canvas-stage-create');
    const stageList = screen.getByTestId('canvas-stage-list');
    expect(createBtn.parentElement).toBe(stageDock);
    expect(stageList.parentElement).toBe(stageDock);
    expect(createBtn).toHaveClass('bg-foreground', 'text-background');
    expect(
      stageList.compareDocumentPosition(createBtn) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // 3D Stage Manager inward fold (left side folds inward with positive rotateY; flattens on hover)
    expect(board2Card.style.transform).toContain('perspective(480px)');
    expect(board2Card.style.transform).toContain('rotateY(16deg)');
    expect(board2Card.style.transformOrigin).toBe('left center');

    fireEvent.mouseEnter(board2Card);
    expect(board2Card.style.transform).toContain('rotateY(0deg)');
    fireEvent.mouseLeave(board2Card);
    expect(board2Card.style.transform).toContain('rotateY(16deg)');

    // Switch canvas
    await user.click(screen.getByRole('button', { name: '调试画布' }));
    expect(onSelectCanvas).toHaveBeenCalledWith('board-2');

    // Create canvas
    await user.click(createBtn);
    expect(onCreateCanvas).toHaveBeenCalledTimes(1);

    // Inline rename on double-click
    await user.dblClick(screen.getByText('调试画布'));
    const renameInput = screen.getByRole('textbox', { name: '重命名画布' });
    await user.clear(renameInput);
    await user.type(renameInput, '核心流程{Enter}');
    expect(onRenameCanvas).toHaveBeenCalledWith('board-2', '核心流程');

    // Delete canvas
    const deleteButtons = screen.getAllByRole('button', { name: '删除画布' });
    await user.click(deleteButtons[0]);
    expect(onDeleteCanvas).toHaveBeenCalledWith('board-2');

    // Right-side alignment flips 3D inward fold to negative rotateY with right transform-origin and right-aligned bottom button
    rerender(
      <SessionCanvasViewportPanel
        mapVisible
        position="bottom-right"
        canvases={sampleCanvases}
        activeCanvasId="default"
        onSelectCanvas={onSelectCanvas}
        onCreateCanvas={onCreateCanvas}
        onRenameCanvas={onRenameCanvas}
        onDeleteCanvas={onDeleteCanvas}
        onMapVisibleChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('canvas-stage-dock')).toHaveClass('items-end');
    const rightAlignedCard = screen.getByTestId('canvas-stage-item-board-2');
    fireEvent.mouseLeave(rightAlignedCard);
    expect(rightAlignedCard.style.transform).toContain('rotateY(-16deg)');
    expect(rightAlignedCard.style.transformOrigin).toBe('right center');
  });

  it('shows only the standalone New Canvas button when only the active canvas exists', async () => {
    const user = userEvent.setup();
    const onCreateCanvas = vi.fn();

    render(
      <SessionCanvasViewportPanel
        mapVisible={false}
        position="bottom-right"
        canvases={[sampleCanvases[0]]}
        activeCanvasId="default"
        onSelectCanvas={vi.fn()}
        onCreateCanvas={onCreateCanvas}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onMapVisibleChange={vi.fn()}
      />
    );

    await user.click(screen.getByTestId('canvas-stage-dock-trigger'));
    expect(screen.getByTestId('canvas-stage-create')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-stage-list')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('canvas-stage-create'));
    expect(onCreateCanvas).toHaveBeenCalledTimes(1);
  });

  it('renders vertical orientation for history dock when docked to side', () => {
    render(
      <SessionCanvasHistoryDock
        canUndo
        canRedo={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        orientation="vertical"
      />
    );
    const toolbar = screen.getByRole('toolbar', { name: '历史' });
    expect(toolbar).toHaveAttribute('aria-orientation', 'vertical');
    expect(toolbar.className).toContain('flex-col');
  });
});
