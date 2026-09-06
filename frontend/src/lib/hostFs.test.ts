import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBackendTransport = vi.hoisted(() => vi.fn());
const openDialog = vi.hoisted(() => vi.fn());
const folderPickerShow = vi.hoisted(() => vi.fn());

vi.mock('@/lib/transport', () => ({
  getBackendTransport,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openDialog,
}));

vi.mock('@/components/dialogs/shared/FolderPickerDialog', () => ({
  FolderPickerDialog: { show: folderPickerShow },
}));

import { pickHostDirectory } from './hostFs';

describe('pickHostDirectory', () => {
  beforeEach(() => {
    getBackendTransport.mockReset();
    openDialog.mockReset();
    folderPickerShow.mockReset();
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
});
