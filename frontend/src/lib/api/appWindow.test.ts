import { beforeEach, describe, expect, it, vi } from 'vitest';

const desktopShellCall = vi.hoisted(() => vi.fn().mockResolvedValue('app-1'));
const isTauriClient = vi.hoisted(() => vi.fn(() => true));

vi.mock('@/lib/desktopShell', () => ({
  desktopShellCall,
  isTauriClient,
}));

import { appWindowApi, openLocalAppWindow } from './appWindow';

describe('appWindowApi', () => {
  beforeEach(() => {
    desktopShellCall.mockClear();
    isTauriClient.mockReturnValue(true);
  });

  it('opens a local app window through the desktop shell', async () => {
    await expect(appWindowApi.open()).resolves.toBe('app-1');
    expect(desktopShellCall).toHaveBeenCalledWith('open_app_window');
  });

  it('opens from the logo menu on a Tauri client, including a bound Host window', () => {
    openLocalAppWindow();
    expect(desktopShellCall).toHaveBeenCalledWith('open_app_window');
  });

  it('does not open a desktop window from Web', () => {
    isTauriClient.mockReturnValue(false);
    openLocalAppWindow();
    expect(desktopShellCall).not.toHaveBeenCalled();
  });
});
