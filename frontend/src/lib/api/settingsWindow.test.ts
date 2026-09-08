import { beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';

const desktopShellCall = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const isTauriClient = vi.hoisted(() => vi.fn(() => true));

vi.mock('@/lib/desktopShell', () => ({
  desktopShellCall,
  isTauriClient,
}));

import { openSettingsSurface, settingsWindowApi } from './settingsWindow';

describe('settingsWindowApi', () => {
  beforeEach(() => {
    desktopShellCall.mockClear();
    isTauriClient.mockReturnValue(true);
  });

  it('opens the settings window with the Chinese title', async () => {
    await i18n.changeLanguage('zh-CN');

    await settingsWindowApi.open();

    expect(desktopShellCall).toHaveBeenCalledWith('open_settings_window', {
      title: '设置',
    });
  });

  it('opens the settings window with the English title', async () => {
    await i18n.changeLanguage('en');

    await settingsWindowApi.open();

    expect(desktopShellCall).toHaveBeenCalledWith('open_settings_window', {
      title: 'Settings',
    });
  });

  it('keeps Settings in a dedicated window on the local desktop', () => {
    const navigate = vi.fn();
    openSettingsSurface(navigate);
    expect(desktopShellCall).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens a companion Settings window from a bound Host window', () => {
    const navigate = vi.fn();
    openSettingsSurface(navigate);
    expect(desktopShellCall).toHaveBeenCalledWith('open_settings_window', {
      title: expect.any(String),
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('can open Settings on a specific page', async () => {
    await i18n.changeLanguage('zh-CN');
    await settingsWindowApi.open('/settings/web-service');
    expect(desktopShellCall).toHaveBeenCalledWith('open_settings_window', {
      title: '设置',
      path: '/settings/web-service',
    });
  });

  it('navigates in-place when Settings is not a desktop window', () => {
    isTauriClient.mockReturnValue(false);
    const navigate = vi.fn();
    openSettingsSurface(navigate);
    expect(navigate).toHaveBeenCalledWith('/settings');
    expect(desktopShellCall).not.toHaveBeenCalled();
  });
});
