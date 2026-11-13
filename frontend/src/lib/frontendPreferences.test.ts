import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));

import {
  isSelfTriggeredSettingsChange,
  resetSelfTriggeredSettingsStateForTests,
  syncFrontendPreferences,
} from './frontendPreferences';

describe('syncFrontendPreferences', () => {
  beforeEach(() => {
    localStorage.clear();
    api.get.mockReset();
    api.update.mockReset();
    resetSelfTriggeredSettingsStateForTests();
  });

  it('applies values edited in settings.json to browser preferences', async () => {
    api.get.mockResolvedValue({ ui_zoom: 1.25, language: 'en' });

    const changed = await syncFrontendPreferences(api);

    expect(changed).toBe(true);
    expect(localStorage.getItem('vibex:ui-zoom')).toBe('1.25');
    expect(localStorage.getItem('vibex:ui-language')).toBe('en');
    expect(api.update).not.toHaveBeenCalled();
  });

  it('syncs session list appearance and mixed grouping from settings', async () => {
    api.get.mockResolvedValue({
      session_list_appearance: 'full',
      kanban_session_list_view: 'mixed',
    });

    await syncFrontendPreferences(api);

    expect(localStorage.getItem('vibex:session-list-appearance')).toBe('full');
    expect(localStorage.getItem('vibex:kanban-session-list-view')).toBe(
      'mixed'
    );
  });

  it('migrates existing browser preferences missing from the JSON document', async () => {
    localStorage.setItem('vibex:mono-font', 'menlo');
    api.get.mockResolvedValue({ ui_zoom: 1 });
    api.update.mockResolvedValue({ ui_zoom: 1, mono_font: 'menlo' });

    await syncFrontendPreferences(api);

    expect(api.update).toHaveBeenCalledWith({ mono_font: 'menlo' });
    expect(isSelfTriggeredSettingsChange()).toBe(true);
  });

  it('does not rewrite identical browser preferences', async () => {
    localStorage.setItem('vibex:ui-zoom', '1.25');
    api.get.mockResolvedValue({ ui_zoom: 1.25 });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    const changed = await syncFrontendPreferences(api);

    expect(changed).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('migrates legacy fixed kanban_board_style to canvas during preference sync', async () => {
    localStorage.setItem('vibex:kanban-board-style', 'fixed');
    api.get.mockResolvedValue({ kanban_board_style: 'fixed' });
    api.update.mockResolvedValue({ kanban_board_style: 'canvas' });

    await syncFrontendPreferences(api);

    expect(api.update).toHaveBeenCalledWith({ kanban_board_style: 'canvas' });
    expect(localStorage.getItem('vibex:kanban-board-style')).toBe('canvas');
  });
});
