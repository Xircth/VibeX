import { describe, expect, it } from 'vitest';
import type { KanbanZone } from '@/lib/layoutArrangement';
import {
  DEFAULT_KANBAN_ZONE_VISIBILITY,
  kanbanOverflowZone,
  kanbanSessionRendersInHub,
  kanbanZoneFills,
  shouldRevealKanbanMonitorOnPlacement,
  shouldShowKanbanMonitor,
  visibleKanbanZones,
} from './kanbanZoneVisibility';

const ORDER: readonly KanbanZone[] = ['list', 'monitor', 'session'];

describe('kanban zone visibility', () => {
  it('keeps every zone visible by default', () => {
    expect(visibleKanbanZones(ORDER, DEFAULT_KANBAN_ZONE_VISIBILITY)).toEqual([
      'list',
      'monitor',
      'session',
    ]);
  });

  it('drops hidden zones without changing the remaining order', () => {
    expect(
      visibleKanbanZones(ORDER, {
        list: true,
        monitor: false,
        session: true,
      })
    ).toEqual(['list', 'session']);
  });

  it('lets the monitor absorb leftover width while it is shown', () => {
    const visibility = { list: true, monitor: true, session: true };

    expect(kanbanOverflowZone(visibility)).toBe('monitor');
    expect(kanbanZoneFills('monitor', visibility)).toBe(true);
    expect(kanbanZoneFills('list', visibility)).toBe(false);
    expect(kanbanZoneFills('session', visibility)).toBe(false);
  });

  it('gives leftover width to the session when the monitor is closed', () => {
    const visibility = { list: true, monitor: false, session: true };

    expect(kanbanOverflowZone(visibility)).toBe('session');
    expect(kanbanZoneFills('session', visibility)).toBe(true);
    expect(kanbanZoneFills('list', visibility)).toBe(false);
  });

  it('lets the list fill only after both the monitor and session are closed', () => {
    const visibility = { list: true, monitor: false, session: false };

    expect(kanbanOverflowZone(visibility)).toBe('list');
    expect(kanbanZoneFills('list', visibility)).toBe(true);
  });

  it('renders the session inside the hub on the session-hub view', () => {
    expect(kanbanSessionRendersInHub('builtin:sessions')).toBe(true);
    expect(kanbanSessionRendersInHub('builtin:columns')).toBe(false);
    expect(kanbanSessionRendersInHub('builtin:usage')).toBe(false);
    expect(kanbanSessionRendersInHub('builtin:canvas')).toBe(false);
  });

  it('hides the monitor column until a session is actually monitored', () => {
    expect(shouldShowKanbanMonitor(true, 0)).toBe(false);
    expect(shouldShowKanbanMonitor(true, 1)).toBe(true);
    expect(shouldShowKanbanMonitor(false, 2)).toBe(false);
  });

  it('reveals the monitor when a newly opened session is queued into it', () => {
    expect(shouldRevealKanbanMonitorOnPlacement(0, 1)).toBe(true);
    expect(shouldRevealKanbanMonitorOnPlacement(1, 2)).toBe(true);
    expect(shouldRevealKanbanMonitorOnPlacement(2, 2)).toBe(false);
    expect(shouldRevealKanbanMonitorOnPlacement(1, 0)).toBe(false);
  });
});
