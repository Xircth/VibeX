import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBackendTransport = vi.hoisted(() => vi.fn());
const openDialog = vi.hoisted(() => vi.fn());
const folderPickerShow = vi.hoisted(() => vi.fn());
const multiFolderPickerShow = vi.hoisted(() => vi.fn());

vi.mock('@/lib/transport', () => ({
  getBackendTransport,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openDialog,
}));

vi.mock('@/components/dialogs/shared/FolderPickerDialog', () => ({
  FolderPickerDialog: { show: folderPickerShow },
  MultiFolderPickerDialog: { show: multiFolderPickerShow },
}));

import { pickHostDirectories, pickHostDirectory } from './hostFs';

describe('pickHostDirectory', () => {
  beforeEach(() => {
    getBackendTransport.mockReset();
    openDialog.mockReset();
    folderPickerShow.mockReset();
    multiFolderPickerShow.mockReset();
  });

  it('uses the native dialog only for a local desktop Host', async () => {
    getBackendTransport.mockReturnValue({ environment: 'desktop' });
    openDialog.mockResolvedValue('/Users/me/code');
    await expect(pickHostDirectory({ title: 'Select' })).resolves.toBe(
      '/Users/me/code'
    );
    expect(folderPickerShow).not.toHaveBeenCalled();
  });

  it('lists directories on the bound Host instead of this machine', async () => {
    getBackendTransport.mockReturnValue({ environment: 'remote-desktop' });
    folderPickerShow.mockResolvedValue('/root/projects');
    await expect(pickHostDirectory()).resolves.toBe('/root/projects');
    expect(openDialog).not.toHaveBeenCalled();
  });

  it('supports selecting multiple folders on desktop and remote hosts', async () => {
    getBackendTransport.mockReturnValue({ environment: 'desktop' });
    openDialog.mockResolvedValue(['/Users/me/a', '/Users/me/b']);
    await expect(pickHostDirectories({ title: 'Import' })).resolves.toEqual([
      '/Users/me/a',
      '/Users/me/b',
    ]);
    expect(openDialog).toHaveBeenCalledWith({
      directory: true,
      multiple: true,
      title: 'Import',
    });

    getBackendTransport.mockReturnValue({ environment: 'remote-desktop' });
    multiFolderPickerShow.mockResolvedValue(['/srv/a', '/srv/b']);
    await expect(pickHostDirectories()).resolves.toEqual(['/srv/a', '/srv/b']);
  });
});
