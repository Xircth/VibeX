import type { KanbanZone } from '@/lib/layoutArrangement';

export type KanbanZoneVisibility = Record<KanbanZone, boolean>;

export const DEFAULT_KANBAN_ZONE_VISIBILITY: KanbanZoneVisibility = {
  list: true,
  monitor: true,
  session: true,
};

export function visibleKanbanZones(
  zoneOrder: readonly KanbanZone[],
  visibility: KanbanZoneVisibility
): KanbanZone[] {
  return zoneOrder.filter((zone) => visibility[zone]);
}

/**
 * Which zone absorbs leftover width. The monitor is the overflow column
 * while it is shown; closing it gives that leftover to the session;
 * closing the session too leaves the list as the last remaining column.
 * Matches workspace Dock on the default kanban arrangement: leftover from
 * the sides goes to the center, leftover from the center goes to the right.
 */
export function kanbanOverflowZone(
  visibility: KanbanZoneVisibility
): KanbanZone | null {
  if (visibility.monitor) return 'monitor';
  if (visibility.session) return 'session';
  if (visibility.list) return 'list';
  return null;
}

export function kanbanZoneFills(
  zone: KanbanZone,
  visibility: KanbanZoneVisibility
): boolean {
  return kanbanOverflowZone(visibility) === zone;
}

/**
 * Session-hub view keeps list / monitor / session in one flex row so leftover
 * width can be given to the filling slot. Other views keep the outer slot.
 */
export function kanbanSessionRendersInHub(viewId: string): boolean {
  return viewId === 'builtin:sessions';
}

/** The monitor is overflow: it does not occupy a column while empty. */
export function shouldShowKanbanMonitor(
  userPrefersVisible: boolean,
  monitoredCount: number
): boolean {
  return userPrefersVisible && monitoredCount > 0;
}

/** Queuing another session into the monitor is a request to see that column. */
export function shouldRevealKanbanMonitorOnPlacement(
  previousCount: number,
  nextCount: number
): boolean {
  return nextCount > previousCount;
}
