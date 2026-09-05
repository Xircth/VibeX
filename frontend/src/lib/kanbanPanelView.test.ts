import { describe, expect, it } from 'vitest';
import {
  getNextKanbanPanelView,
  getPreviousKanbanPanelView,
  getKanbanPanelTranslateX,
  shouldHideKanbanSessionSlot,
  shouldShowLeftArrow,
  shouldShowRightArrow,
} from './kanbanPanelView';

describe('kanbanPanelView', () => {
  describe('getNextKanbanPanelView', () => {
    it('moves forward from board to session hub', () => {
      expect(getNextKanbanPanelView('board')).toBe('sessionHub');
    });

    it('moves forward from session hub to usage dashboard', () => {
      expect(getNextKanbanPanelView('sessionHub')).toBe('usageDashboard');
    });

    it('stays at usage dashboard when already at end', () => {
      expect(getNextKanbanPanelView('usageDashboard')).toBe('usageDashboard');
    });
  });

  describe('getPreviousKanbanPanelView', () => {
    it('moves backward from usage dashboard to session hub', () => {
      expect(getPreviousKanbanPanelView('usageDashboard')).toBe('sessionHub');
    });

    it('moves backward from session hub to board', () => {
      expect(getPreviousKanbanPanelView('sessionHub')).toBe('board');
    });

    it('stays at board when already at start', () => {
      expect(getPreviousKanbanPanelView('board')).toBe('board');
    });
  });

  describe('getKanbanPanelTranslateX', () => {
    it('returns 0% for board', () => {
      expect(getKanbanPanelTranslateX('board')).toBe('translateX(0%)');
    });

    it('returns -33.333% for sessionHub', () => {
      expect(getKanbanPanelTranslateX('sessionHub')).toBe(
        'translateX(-33.333%)'
      );
    });

    it('returns -66.666% for usageDashboard', () => {
      expect(getKanbanPanelTranslateX('usageDashboard')).toBe(
        'translateX(-66.666%)'
      );
    });
  });

  describe('shouldShowLeftArrow', () => {
    it('hides left arrow on board', () => {
      expect(shouldShowLeftArrow('board')).toBe(false);
    });

    it('shows left arrow on sessionHub', () => {
      expect(shouldShowLeftArrow('sessionHub')).toBe(true);
    });

    it('shows left arrow on usageDashboard', () => {
      expect(shouldShowLeftArrow('usageDashboard')).toBe(true);
    });
  });

  describe('shouldShowRightArrow', () => {
    it('shows right arrow on board', () => {
      expect(shouldShowRightArrow('board')).toBe(true);
    });

    it('shows right arrow on sessionHub', () => {
      expect(shouldShowRightArrow('sessionHub')).toBe(true);
    });

    it('hides right arrow on usageDashboard', () => {
      expect(shouldShowRightArrow('usageDashboard')).toBe(false);
    });
  });

  describe('shouldHideKanbanSessionSlot', () => {
    it('hides the execution column on the usage dashboard in fixed layout', () => {
      expect(shouldHideKanbanSessionSlot('usageDashboard', false)).toBe(true);
    });

    it('keeps the execution column on the board and session hub in fixed layout', () => {
      expect(shouldHideKanbanSessionSlot('board', false)).toBe(false);
      expect(shouldHideKanbanSessionSlot('sessionHub', false)).toBe(false);
    });

    it('hides the execution column on canvas session views', () => {
      expect(shouldHideKanbanSessionSlot('sessionHub', true)).toBe(true);
      expect(shouldHideKanbanSessionSlot('usageDashboard', true)).toBe(true);
    });
  });
});
