import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));

import { syncFrontendPreferences } from './frontendPreferences';

describe('syncFrontendPreferences', () => {
  beforeEach(() => {
    localStorage.clear();
    api.get.mockReset();
    api.update.mockReset();
  });

  it('applies values edited in settings.json to browser preferences', async () => {
    api.get.mockResolvedValue({ ui_zoom: 1.25, language: 'en' });

    await syncFrontendPreferences(api);

    expect(localStorage.getItem('vibex:ui-zoom')).toBe('1.25');
    expect(localStorage.getItem('vibex:ui-language')).toBe('en');
    expect(api.update).not.toHaveBeenCalled();
  });

  it('migrates existing browser preferences missing from the JSON document', async () => {
    localStorage.setItem('vibex:mono-font', 'menlo');
    api.get.mockResolvedValue({ ui_zoom: 1 });
    api.update.mockResolvedValue({ ui_zoom: 1, mono_font: 'menlo' });

    await syncFrontendPreferences(api);

    expect(api.update).toHaveBeenCalledWith({ mono_font: 'menlo' });
  });
});
