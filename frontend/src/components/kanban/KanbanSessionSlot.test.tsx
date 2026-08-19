import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RightPanelSlotContext } from '@/contexts/RightPanelSlotContext';
import {
  DEFAULT_KANBAN_ARRANGEMENT,
  resetKanbanArrangement,
  setKanbanArrangement,
} from '@/lib/layoutArrangement';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { KanbanSessionSlot } from './KanbanSessionSlot';

function renderSlot(side: 'left' | 'center' | 'right' = 'center') {
  const host = document.createElement('div');
  host.textContent = 'session-host';

  let view!: ReturnType<typeof render>;
  act(() => {
    view = render(
      <RightPanelSlotContext.Provider value={{ host, placement: 'kanban' }}>
        <KanbanSessionSlot side={side} active />
      </RightPanelSlotContext.Provider>
    );
  });
  return view;
}

describe('KanbanSessionSlot', () => {
  beforeEach(() => {
    resetKanbanArrangement();
    useLayoutStore.getState().resetLayout();
    useLayoutStore.getState().setKanbanSessionWidth(520);
    useLayoutStore.getState().setKanbanSessionVisible(true);
  });

  afterEach(() => {
    resetKanbanArrangement();
    useLayoutStore.getState().resetLayout();
  });

  it('puts the resize handle on the monitor-facing edge after swapping zones', () => {
    setKanbanArrangement({
      left: 'list',
      center: 'session',
      right: 'monitor',
    });

    const { container } = renderSlot('center');
    const slot = container.querySelector('[data-panel="kanban-session-slot"]');
    const handle = screen.getByRole('separator');

    expect(handle).toHaveAttribute('data-handle-side', 'right');
    expect(slot?.lastElementChild).toBe(handle);
  });

  it('widens the session when the monitor-facing handle is dragged toward the monitor', () => {
    setKanbanArrangement({
      left: 'list',
      center: 'session',
      right: 'monitor',
    });

    renderSlot('center');
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
});
