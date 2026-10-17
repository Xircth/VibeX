import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistFrontendPreference = vi.hoisted(() => vi.fn());

vi.mock('./frontendPreferences', () => ({
  persistFrontendPreference,
}));

import {
  DEFAULT_SETTINGS_NAV_FLOAT,
  SETTINGS_NAV_FLOAT_KEY,
  getSettingsNavFloat,
  resetSettingsNavFloat,
  setSettingsNavFloat,
  subscribeSettingsNavFloat,
} from './settingsNavFloat';

describe('settingsNavFloat', () => {
  beforeEach(() => {
    resetSettingsNavFloat();
    persistFrontendPreference.mockReset();
  });

  it('defaults to a floating settings menu', () => {
    expect(getSettingsNavFloat()).toBe(DEFAULT_SETTINGS_NAV_FLOAT);
    expect(getSettingsNavFloat()).toBe(true);
  });

  it('persists turning the floating menu off', () => {
    setSettingsNavFloat(false);

    expect(localStorage.getItem(SETTINGS_NAV_FLOAT_KEY)).toBe('false');
    expect(persistFrontendPreference).toHaveBeenCalledWith(
      SETTINGS_NAV_FLOAT_KEY,
      false
    );
    expect(getSettingsNavFloat()).toBe(false);
  });

  it('treats unknown stored values as the floating default', () => {
    localStorage.setItem(SETTINGS_NAV_FLOAT_KEY, 'maybe');

    expect(getSettingsNavFloat()).toBe(true);
  });

  it('notifies subscribers on change', () => {
    let notified = 0;
    const unsubscribe = subscribeSettingsNavFloat(() => {
      notified += 1;
    });

    setSettingsNavFloat(false);
    unsubscribe();
    setSettingsNavFloat(true);

    expect(notified).toBe(1);
  });
});
