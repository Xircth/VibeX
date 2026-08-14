import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistFrontendPreference = vi.hoisted(() => vi.fn());
const backendCall = vi.hoisted(() => vi.fn());

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference,
}));

vi.mock('@/lib/backendTransport', () => ({
  backendCall,
  configuredBackendTransport: { environment: 'tauri' },
}));

import {
  APP_ICON_STYLE_KEY,
  applyNativeAppIcon,
  getAppIconStyle,
  resolveAppLogo,
  setAppIconStyle,
} from './appIcon';

describe('app icon preference', () => {
  beforeEach(() => {
    localStorage.clear();
    persistFrontendPreference.mockReset();
    backendCall.mockReset();
  });

  it('defaults to the standard icon and ignores unknown stored values', () => {
    expect(getAppIconStyle()).toBe('default');

    localStorage.setItem(APP_ICON_STYLE_KEY, 'unknown');

    expect(getAppIconStyle()).toBe('default');
  });

  it('persists a valid style and notifies live logo consumers', () => {
    const listener = vi.fn();
    window.addEventListener('vibex:app-icon-changed', listener);

    setAppIconStyle('lite');

    expect(localStorage.getItem(APP_ICON_STYLE_KEY)).toBe('lite');
    expect(persistFrontendPreference).toHaveBeenCalledWith(
      APP_ICON_STYLE_KEY,
      'lite'
    );
    expect(listener).toHaveBeenCalledOnce();

    window.removeEventListener('vibex:app-icon-changed', listener);
  });

  it('maps both icon styles to the matching light and dark assets', () => {
    expect(resolveAppLogo('default', 'light')).toContain(
      'app-logo-light-default.png'
    );
    expect(resolveAppLogo('default', 'dark')).toContain('app-logo-dark.png');
    expect(resolveAppLogo('lite', 'light')).toContain(
      'app-logo-light-lite.png'
    );
    expect(resolveAppLogo('lite', 'dark')).toContain('app-logo-dark-lite.png');
  });

  it('applies the resolved style and theme to the native application icon', async () => {
    backendCall.mockResolvedValue(undefined);

    await applyNativeAppIcon('lite', 'dark');

    expect(backendCall).toHaveBeenCalledWith('set_app_icon', {
      style: 'lite',
      theme: 'dark',
    });
  });
});
