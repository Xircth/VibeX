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

export function kanbanListFillsHub(
  visibility: KanbanZoneVisibility,
  sessionInHub: boolean
): boolean {
  return !visibility.monitor && !(sessionInHub && visibility.session);
}

export function kanbanSessionFillsHub(
  sessionInHub: boolean,
  visibility: KanbanZoneVisibility
): boolean {
  return sessionInHub && visibility.session && !visibility.monitor;
}
