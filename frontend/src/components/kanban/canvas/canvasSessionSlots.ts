import { useSyncExternalStore } from 'react';
import {
  sessionSlotClasses,
  sessionSlotHue,
  type SessionMarker,
} from '@/components/kanban/session-hub/utils';

const listeners = new Set<() => void>();
let slotSessionIds: readonly string[] = [];

function emit() {
  for (const listener of [...listeners]) listener();
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

/** Session ids in the same order the infinite canvas uses for node-header slot colors. */
export function setCanvasSessionSlotIds(nextIds: readonly string[]): void {
  if (sameIds(slotSessionIds, nextIds)) return;
  slotSessionIds = nextIds;
  emit();
}

/** Drop this canvas's ids only while they are still the published snapshot. */
export function clearCanvasSessionSlotIdsIfCurrent(
  expected: readonly string[]
): void {
  if (slotSessionIds.length === 0 || !sameIds(slotSessionIds, expected)) return;
  slotSessionIds = [];
  emit();
}

export function getCanvasSessionSlotIds(): readonly string[] {
  return slotSessionIds;
}

export function subscribeCanvasSessionSlotIds(
  listener: () => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCanvasSessionSlotIds(): readonly string[] {
  return useSyncExternalStore(
    subscribeCanvasSessionSlotIds,
    getCanvasSessionSlotIds,
    () => []
  );
}

export function canvasSessionListMarker(
  sessionId: string,
  ids: readonly string[] = slotSessionIds
): SessionMarker | null {
  const index = ids.indexOf(sessionId);
  if (index < 0) return null;
  return {
    bar: sessionSlotClasses(index).bar,
    hue: sessionSlotHue(index),
  };
}
