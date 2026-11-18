import { describe, expect, it, beforeEach } from 'vitest';
import {
  canvasSessionListMarker,
  clearCanvasSessionSlotIdsIfCurrent,
  getCanvasSessionSlotIds,
  setCanvasSessionSlotIds,
} from './canvasSessionSlots';

describe('canvasSessionSlots', () => {
  beforeEach(() => {
    setCanvasSessionSlotIds([]);
  });

  it('maps a placed session to the same slot hue the canvas node header uses', () => {
    setCanvasSessionSlotIds(['sess-a', 'sess-b']);

    expect(canvasSessionListMarker('sess-a')).toEqual({
      bar: 'session-marker-slot-1',
      hue: 'var(--session-slot-1)',
    });
    expect(canvasSessionListMarker('sess-b')).toEqual({
      bar: 'session-marker-slot-2',
      hue: 'var(--session-slot-2)',
    });
    expect(canvasSessionListMarker('missing')).toBeNull();
    expect(getCanvasSessionSlotIds()).toEqual(['sess-a', 'sess-b']);
  });

  it('clears the snapshot only when the caller still owns it', () => {
    const owned = ['sess-a'];
    setCanvasSessionSlotIds(owned);
    setCanvasSessionSlotIds(['sess-b']);
    clearCanvasSessionSlotIdsIfCurrent(owned);
    expect(getCanvasSessionSlotIds()).toEqual(['sess-b']);

    clearCanvasSessionSlotIdsIfCurrent(['sess-b']);
    expect(getCanvasSessionSlotIds()).toEqual([]);
  });
});
