import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_IDS } from '@/stores/useLayoutStore';

const persistFrontendPreference = vi.hoisted(() => vi.fn());

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference,
}));

import {
  ACTIVITY_RAIL_ORDER_KEY,
  ACTIVITY_RAIL_PANEL_TITLES,
  DEFAULT_ACTIVITY_RAIL_ORDER,
  getActivityRailOrder,
  getDefaultActivityRailPanelId,
  moveActivityRailItem,
  nudgeActivityRailItem,
  otherActivityRailPanels,
  resetActivityRailOrder,
  sanitizeActivityRailOrder,
  setActivityRailOrder,
  subscribeActivityRailOrder,
} from './activityRailOrder';

describe('activityRailOrder', () => {
  beforeEach(() => {
    resetActivityRailOrder();
    persistFrontendPreference.mockReset();
  });

  it('defaults to files, git, search, then sessions', () => {
    expect(getActivityRailOrder()).toEqual([...DEFAULT_ACTIVITY_RAIL_ORDER]);
    expect(getDefaultActivityRailPanelId()).toBe(PANEL_IDS.FILE_TREE);
  });

  it('uses the first item as the default left panel', () => {
    setActivityRailOrder([
      PANEL_IDS.SESSION_LIST,
      PANEL_IDS.FILE_TREE,
      PANEL_IDS.GIT,
      PANEL_IDS.SEARCH,
    ]);

    expect(getDefaultActivityRailPanelId()).toBe(PANEL_IDS.SESSION_LIST);
    expect(ACTIVITY_RAIL_PANEL_TITLES[getDefaultActivityRailPanelId()]).toBe(
      'Sessions'
    );
  });

  it('persists a reordered rail', () => {
    const next = [
      PANEL_IDS.SESSION_LIST,
      PANEL_IDS.FILE_TREE,
      PANEL_IDS.GIT,
      PANEL_IDS.SEARCH,
    ];
    setActivityRailOrder(next);

    expect(
      JSON.parse(localStorage.getItem(ACTIVITY_RAIL_ORDER_KEY) ?? '[]')
    ).toEqual(next);
    expect(persistFrontendPreference).toHaveBeenCalledWith(
      ACTIVITY_RAIL_ORDER_KEY,
      next
    );
    expect(getActivityRailOrder()).toEqual(next);
  });

  it('fills in missing items and drops unknown ids', () => {
    expect(
      sanitizeActivityRailOrder([PANEL_IDS.SESSION_LIST, 'logs', PANEL_IDS.GIT])
    ).toEqual([
      PANEL_IDS.SESSION_LIST,
      PANEL_IDS.GIT,
      PANEL_IDS.FILE_TREE,
      PANEL_IDS.SEARCH,
    ]);
  });

  it('ignores invalid persisted values', () => {
    localStorage.setItem(ACTIVITY_RAIL_ORDER_KEY, 'not-json');
    expect(getActivityRailOrder()).toEqual([...DEFAULT_ACTIVITY_RAIL_ORDER]);
  });

  it('moves the dragged item to the drop target and shifts the rest', () => {
    expect(
      moveActivityRailItem(
        [...DEFAULT_ACTIVITY_RAIL_ORDER],
        PANEL_IDS.SESSION_LIST,
        PANEL_IDS.FILE_TREE
      )
    ).toEqual([
      PANEL_IDS.SESSION_LIST,
      PANEL_IDS.FILE_TREE,
      PANEL_IDS.GIT,
      PANEL_IDS.SEARCH,
    ]);
  });

  it('returns null when the drop does not change order', () => {
    expect(
      moveActivityRailItem(
        [...DEFAULT_ACTIVITY_RAIL_ORDER],
        PANEL_IDS.FILE_TREE,
        PANEL_IDS.FILE_TREE
      )
    ).toBe(null);
  });

  it('nudges an item one slot earlier or later', () => {
    expect(
      nudgeActivityRailItem([...DEFAULT_ACTIVITY_RAIL_ORDER], PANEL_IDS.GIT, -1)
    ).toEqual([
      PANEL_IDS.GIT,
      PANEL_IDS.FILE_TREE,
      PANEL_IDS.SEARCH,
      PANEL_IDS.SESSION_LIST,
    ]);
    expect(
      nudgeActivityRailItem(
        [...DEFAULT_ACTIVITY_RAIL_ORDER],
        PANEL_IDS.FILE_TREE,
        -1
      )
    ).toBe(null);
  });

  it('lists the other left dock panels for a target', () => {
    expect(otherActivityRailPanels(PANEL_IDS.SESSION_LIST)).toEqual([
      PANEL_IDS.FILE_TREE,
      PANEL_IDS.GIT,
      PANEL_IDS.SEARCH,
    ]);
  });

  it('notifies subscribers on change', () => {
    let notified = 0;
    const unsubscribe = subscribeActivityRailOrder(() => {
      notified += 1;
    });

    setActivityRailOrder([
      PANEL_IDS.SESSION_LIST,
      PANEL_IDS.FILE_TREE,
      PANEL_IDS.GIT,
      PANEL_IDS.SEARCH,
    ]);
    unsubscribe();
    resetActivityRailOrder();

    expect(notified).toBe(1);
  });
});
