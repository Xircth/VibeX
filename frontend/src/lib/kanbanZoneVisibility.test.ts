import { describe, expect, it } from 'vitest';
import type { KanbanZone } from '@/lib/layoutArrangement';
import {
  DEFAULT_KANBAN_ZONE_VISIBILITY,
  kanbanListFillsHub,
  kanbanSessionFillsHub,
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

  it('lets the list fill the hub only when it is the last remaining hub zone', () => {
    expect(
      kanbanListFillsHub({ list: true, monitor: false, session: false }, false)
    ).toBe(true);
    expect(
      kanbanListFillsHub({ list: true, monitor: false, session: true }, true)
    ).toBe(false);
    expect(
      kanbanListFillsHub({ list: true, monitor: true, session: true }, false)
    ).toBe(false);
  });

  it('lets the in-hub session fill leftover space when the monitor is hidden', () => {
    expect(
      kanbanSessionFillsHub(true, {
        list: true,
        monitor: false,
        session: true,
      })
    ).toBe(true);
    expect(
      kanbanSessionFillsHub(false, {
        list: true,
        monitor: false,
        session: true,
      })
    ).toBe(false);
  });
});
