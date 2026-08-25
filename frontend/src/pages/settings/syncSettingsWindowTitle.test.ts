import { beforeEach, describe, expect, it, vi } from 'vitest';

const setTitle = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const getCurrentWindow = vi.hoisted(() =>
  vi.fn(() => ({
    label: 'settings',
    setTitle,
  }))
);

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow,
}));

import { syncSettingsWindowTitle } from './syncSettingsWindowTitle';

describe('syncSettingsWindowTitle', () => {
  beforeEach(() => {
    setTitle.mockClear();
    getCurrentWindow.mockReset();
    getCurrentWindow.mockReturnValue({
      label: 'settings',
      setTitle,
    });
  });

  it('sets the native title only on the settings window', async () => {
    await syncSettingsWindowTitle('设置');

    expect(setTitle).toHaveBeenCalledWith('设置');
  });

  it('does not retitle the main window', async () => {
    getCurrentWindow.mockReturnValue({
      label: 'main',
      setTitle,
    });

    await syncSettingsWindowTitle('Settings');

    expect(setTitle).not.toHaveBeenCalled();
  });

  it('ignores missing native window APIs', async () => {
    getCurrentWindow.mockImplementation(() => {
      throw new Error('not a Tauri window');
    });

    await expect(syncSettingsWindowTitle('Settings')).resolves.toBeUndefined();
    expect(setTitle).not.toHaveBeenCalled();
  });
});
