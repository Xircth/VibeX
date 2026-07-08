import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_KANBAN_ARRANGEMENT,
  DEFAULT_LAYOUT_ARRANGEMENT,
  arrangementsEqual,
  getKanbanArrangement,
  getLayoutArrangement,
  isDefaultArrangement,
  kanbanSlotOfZone,
  resetKanbanArrangement,
  resetLayoutArrangement,
  setKanbanArrangement,
  setLayoutArrangement,
  slotOfZone,
  subscribeLayoutArrangement,
  swapArrangementSlots,
} from './layoutArrangement';

describe('layoutArrangement', () => {
  beforeEach(() => {
    resetLayoutArrangement();
  });

  it('defaults to A/B/C/D in left/center/right/bottom', () => {
    expect(getLayoutArrangement()).toEqual({
      left: 'dock',
      center: 'workspace',
      right: 'session',
      bottom: 'terminal',
    });
    expect(isDefaultArrangement(getLayoutArrangement())).toBe(true);
  });

  it('swaps two slots and keeps the mapping bijective', () => {
    const swapped = swapArrangementSlots(
      DEFAULT_LAYOUT_ARRANGEMENT,
      'center',
      'right'
    );

    expect(swapped.center).toBe('session');
    expect(swapped.right).toBe('workspace');
    expect(swapped.left).toBe('dock');
    expect(swapped.bottom).toBe('terminal');
    expect(new Set(Object.values(swapped)).size).toBe(4);
  });

  it('persists and reads back an arrangement', () => {
    const next = swapArrangementSlots(
      DEFAULT_LAYOUT_ARRANGEMENT,
      'left',
      'bottom'
    );
    setLayoutArrangement(next);

    expect(getLayoutArrangement()).toEqual(next);
    expect(arrangementsEqual(getLayoutArrangement(), next)).toBe(true);
    expect(isDefaultArrangement(getLayoutArrangement())).toBe(false);
  });

  it('ignores invalid persisted values', () => {
    localStorage.setItem(
      'vibex:layout-arrangement',
      JSON.stringify({ left: 'dock', center: 'dock', right: 'session' })
    );

    expect(getLayoutArrangement()).toEqual(DEFAULT_LAYOUT_ARRANGEMENT);
  });

  it('notifies subscribers on change', () => {
    let notified = 0;
    const unsubscribe = subscribeLayoutArrangement(() => {
      notified += 1;
    });

    setLayoutArrangement(
      swapArrangementSlots(DEFAULT_LAYOUT_ARRANGEMENT, 'center', 'right')
    );
    unsubscribe();
    resetLayoutArrangement();

    expect(notified).toBe(1);
  });

  it('finds the slot of a zone', () => {
    const arrangement = swapArrangementSlots(
      DEFAULT_LAYOUT_ARRANGEMENT,
      'right',
      'bottom'
    );

    expect(slotOfZone(arrangement, 'session')).toBe('bottom');
    expect(slotOfZone(arrangement, 'terminal')).toBe('right');
    expect(slotOfZone(arrangement, 'workspace')).toBe('center');
  });

  describe('kanban arrangement', () => {
    beforeEach(() => {
      resetKanbanArrangement();
    });

    it('defaults to list/monitor/session and is independent from workspace', () => {
      expect(getKanbanArrangement()).toEqual({
        left: 'list',
        center: 'monitor',
        right: 'session',
      });

      setLayoutArrangement(
        swapArrangementSlots(DEFAULT_LAYOUT_ARRANGEMENT, 'center', 'right')
      );
      expect(getKanbanArrangement()).toEqual(DEFAULT_KANBAN_ARRANGEMENT);
    });

    it('persists a swap and reports zone slots', () => {
      const swapped = swapArrangementSlots(
        DEFAULT_KANBAN_ARRANGEMENT,
        'center',
        'right'
      );
      setKanbanArrangement(swapped);

      expect(getKanbanArrangement()).toEqual({
        left: 'list',
        center: 'session',
        right: 'monitor',
      });
      expect(kanbanSlotOfZone(getKanbanArrangement(), 'session')).toBe(
        'center'
      );
      // The workspace arrangement is unaffected by kanban changes.
      expect(getLayoutArrangement()).toEqual(DEFAULT_LAYOUT_ARRANGEMENT);
    });

    it('rejects non-bijective values', () => {
      localStorage.setItem(
        'vibex:kanban-layout-arrangement',
        JSON.stringify({ left: 'list', center: 'list', right: 'session' })
      );

      expect(getKanbanArrangement()).toEqual(DEFAULT_KANBAN_ARRANGEMENT);
    });
  });
});
