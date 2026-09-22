import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('keeps the app-update toast from replacing the current desktop window', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../App.tsx'),
      'utf8'
    );
    expect(source).toContain(
      "openSettingsSurface(navigate, '/settings/system')"
    );
    expect(source).not.toContain("navigate('/settings/system')");
  });

  it('opens a specific Settings page in a dedicated window on the desktop', () => {
    const navigate = vi.fn();
    openSettingsSurface(navigate, '/settings/system');
    expect(desktopShellCall).toHaveBeenCalledWith('open_settings_window', {
      title: expect.any(String),
      path: '/settings/system',
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates in-place when Settings is not a desktop window', () => {
    isTauriClient.mockReturnValue(false);
    const navigate = vi.fn();
    openSettingsSurface(navigate);
    expect(navigate).toHaveBeenCalledWith('/settings');
    expect(desktopShellCall).not.toHaveBeenCalled();
  });

  it('navigates in-place to a specific page on web', () => {
    isTauriClient.mockReturnValue(false);
    const navigate = vi.fn();
    openSettingsSurface(navigate, '/settings/system');
    expect(navigate).toHaveBeenCalledWith('/settings/system');
    expect(desktopShellCall).not.toHaveBeenCalled();
  });
});
