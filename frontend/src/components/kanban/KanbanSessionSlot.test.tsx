import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getRightPanelHostConsumerCount,
  RightPanelSlotContext,
  useIsRightPanelHostAttached,
} from '@/contexts/RightPanelSlotContext';
import {
  DEFAULT_KANBAN_ARRANGEMENT,
  resetKanbanArrangement,
  setKanbanArrangement,
} from '@/lib/layoutArrangement';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { KanbanSessionSlot } from './KanbanSessionSlot';

const kanbanSessionContext = vi.hoisted(() => ({
  monitorSessions: [] as Array<{ sessionId: string; workspaceId: string }>,
}));

vi.mock('@/contexts/KanbanSessionContext', () => ({
  useKanbanSessionContext: () => kanbanSessionContext,
}));

function renderSlot(
  side: 'left' | 'center' | 'right' = 'center',
  inHub = false
) {
  const host = document.createElement('div');
  host.textContent = 'session-host';

  let view!: ReturnType<typeof render>;
  act(() => {
    view = render(
      <RightPanelSlotContext.Provider value={{ host, placement: 'kanban' }}>
        <KanbanSessionSlot side={side} active inHub={inHub} />
      </RightPanelSlotContext.Provider>
    );
  });
  return view;
}

describe('KanbanSessionSlot', () => {
  beforeEach(() => {
    resetKanbanArrangement();
    kanbanSessionContext.monitorSessions = [];
    useLayoutStore.getState().resetLayout();
    useLayoutStore.getState().setKanbanSessionWidth(520);
    useLayoutStore.getState().setKanbanSessionVisible(true);
  });

  afterEach(() => {
    resetKanbanArrangement();
    useLayoutStore.getState().resetLayout();
  });

  it('lets the in-hub session fill leftover space when nothing is monitored', () => {
    setKanbanArrangement({
      left: 'list',
      center: 'session',
      right: 'monitor',
    });

    const { container } = renderSlot('center', true);
    const slot = container.querySelector('[data-panel="kanban-session-slot"]');

    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(slot).toHaveClass('flex-1');
  });

  it('lets the right-side session fill leftover space when the monitor is hidden', () => {
    setKanbanArrangement(DEFAULT_KANBAN_ARRANGEMENT);

    const { container } = renderSlot('right', true);
    const slot = container.querySelector('[data-panel="kanban-session-slot"]');

    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(slot).toHaveClass('flex-1');
  });

  it('keeps the right-side session at its stored width while the monitor is shown', () => {
    kanbanSessionContext.monitorSessions = [
      { sessionId: 'monitor-1', workspaceId: 'workspace-1' },
    ];
    setKanbanArrangement(DEFAULT_KANBAN_ARRANGEMENT);

    const { container } = renderSlot('right', true);
    const slot = container.querySelector('[data-panel="kanban-session-slot"]');
    const handle = screen.getByRole('separator');

    expect(handle).toHaveAttribute('data-handle-side', 'left');
    expect(slot).not.toHaveClass('flex-1');
    expect(slot?.querySelector('.workspace-right-panel')).toHaveStyle({
      width: '520px',
    });
  });

  it('keeps the outer session at its stored width beside other kanban views', () => {
    setKanbanArrangement(DEFAULT_KANBAN_ARRANGEMENT);

    const { container } = renderSlot('right');
    const slot = container.querySelector('[data-panel="kanban-session-slot"]');

    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(slot).not.toHaveClass('flex-1');
    expect(slot?.querySelector('.workspace-right-panel')).toHaveStyle({
      width: '520px',
    });
  });

  it('puts the resize handle on the monitor-facing edge after swapping zones', () => {
    kanbanSessionContext.monitorSessions = [
      { sessionId: 'monitor-1', workspaceId: 'workspace-1' },
    ];
    setKanbanArrangement({
      left: 'list',
      center: 'session',
      right: 'monitor',
    });

    const { container } = renderSlot('center', true);
    const slot = container.querySelector('[data-panel="kanban-session-slot"]');
    const handle = screen.getByRole('separator');

    expect(handle).toHaveAttribute('data-handle-side', 'right');
    expect(slot?.lastElementChild).toBe(handle);
  });

  it('widens the session when the monitor-facing handle is dragged toward the monitor', () => {
    kanbanSessionContext.monitorSessions = [
      { sessionId: 'monitor-1', workspaceId: 'workspace-1' },
    ];
    setKanbanArrangement({
      left: 'list',
      center: 'session',
      right: 'monitor',
    });

    renderSlot('center', true);
    const handle = screen.getByRole('separator');

    fireEvent.mouseDown(handle, { clientX: 400 });
    fireEvent.mouseMove(document, { clientX: 460 });
    fireEvent.mouseUp(document);

    expect(useLayoutStore.getState().kanbanSessionWidth).toBe(580);
  });

  it('hides the slot when the kanban session zone is collapsed', () => {
    useLayoutStore.getState().setKanbanSessionVisible(false);

    const { container } = renderSlot('right');

    expect(
      container.querySelector('[data-panel="kanban-session-slot"]')
    ).toBeNull();
  });

  it('keeps the default handle on the left edge of a right-side session', () => {
    kanbanSessionContext.monitorSessions = [
      { sessionId: 'monitor-1', workspaceId: 'workspace-1' },
    ];
    setKanbanArrangement(DEFAULT_KANBAN_ARRANGEMENT);

    const { container } = renderSlot('right');
    const slot = container.querySelector('[data-panel="kanban-session-slot"]');
    const handle = screen.getByRole('separator');

    expect(handle).toHaveAttribute('data-handle-side', 'left');
    expect(slot?.firstElementChild).toBe(handle);

    fireEvent.mouseDown(handle, { clientX: 400 });
    fireEvent.mouseMove(document, { clientX: 460 });
    fireEvent.mouseUp(document);

    expect(useLayoutStore.getState().kanbanSessionWidth).toBe(460);
  });

  it('retains the shared host while owning kanban placement and releases it when collapsed or switched to workspace', () => {
    const host = document.createElement('div');
    host.textContent = 'session-host';

    function AttachmentProbe({ target }: { target: HTMLElement | null }) {
      const attached = useIsRightPanelHostAttached(target);
      return <span data-testid="host-attached">{String(attached)}</span>;
    }

    const view = render(
      <RightPanelSlotContext.Provider value={{ host, placement: 'kanban' }}>
        <AttachmentProbe target={host} />
        <AttachmentProbe target={null} />
        <KanbanSessionSlot side="right" active />
      </RightPanelSlotContext.Provider>
    );

    const probes = screen.getAllByTestId('host-attached');
    expect(probes[0]).toHaveTextContent('true');
    // `host === null` always reports attached for standalone backward compatibility.
    expect(probes[1]).toHaveTextContent('true');
    expect(getRightPanelHostConsumerCount(host)).toBe(1);

    // Switching placement away from kanban releases host ownership.
    view.rerender(
      <RightPanelSlotContext.Provider value={{ host, placement: 'workspace' }}>
        <AttachmentProbe target={host} />
        <AttachmentProbe target={null} />
        <KanbanSessionSlot side="right" active />
      </RightPanelSlotContext.Provider>
    );

    expect(screen.getAllByTestId('host-attached')[0]).toHaveTextContent(
      'false'
    );
    expect(getRightPanelHostConsumerCount(host)).toBe(0);

    // Restoring kanban placement re-attaches, and collapsing the kanban session zone releases it.
    view.rerender(
      <RightPanelSlotContext.Provider value={{ host, placement: 'kanban' }}>
        <AttachmentProbe target={host} />
        <AttachmentProbe target={null} />
        <KanbanSessionSlot side="right" active />
      </RightPanelSlotContext.Provider>
    );
    expect(getRightPanelHostConsumerCount(host)).toBe(1);

    act(() => {
      useLayoutStore.getState().setKanbanSessionVisible(false);
    });
    expect(getRightPanelHostConsumerCount(host)).toBe(0);
    expect(screen.getAllByTestId('host-attached')[0]).toHaveTextContent(
      'false'
    );
  });
});
