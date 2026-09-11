import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ isTauriDesktopShell: vi.fn(() => true) }));
const invoke = vi.hoisted(() => vi.fn());

vi.mock('@/utils/platform', () => platform);
vi.mock('@/lib/tauriApi', () => ({ tauriInvoke: invoke }));

/** The granted-directory set is module state, so each test needs a fresh copy. */
async function loadScope() {
  vi.resetModules();
  return import('./previewAssetScope');
}

describe('previewAssetScope', () => {
  beforeEach(() => {
    platform.isTauriDesktopShell.mockReturnValue(true);
    invoke.mockReset().mockResolvedValue(undefined);
  });

  it('grants each directory to the webview exactly once', async () => {
    const { allowPreviewAssetScope } = await loadScope();

    await allowPreviewAssetScope(['/workspace', '/workspace/docs']);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('allow_preview_asset_scope', {
      directories: ['/workspace', '/workspace/docs'],
    });

    await allowPreviewAssetScope(['/workspace']);
    expect(invoke).toHaveBeenCalledTimes(1);

    // Only the directory that is genuinely new travels over IPC.
    await allowPreviewAssetScope(['/workspace', '/elsewhere']);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith('allow_preview_asset_scope', {
      directories: ['/elsewhere'],
    });
  });

  it('leaves a directory ungranted when the command fails', async () => {
    const { allowPreviewAssetScope, isPreviewAssetScopeGranted } =
      await loadScope();
    invoke.mockRejectedValueOnce(new Error('ipc unavailable'));

    await expect(allowPreviewAssetScope(['/workspace'])).rejects.toThrow(
      'ipc unavailable'
    );
    expect(isPreviewAssetScopeGranted(['/workspace'])).toBe(false);
  });

  it('never touches the native scope outside the desktop shell', async () => {
    platform.isTauriDesktopShell.mockReturnValue(false);
    const { allowPreviewAssetScope, isPreviewAssetScopeGranted } =
      await loadScope();

    await allowPreviewAssetScope(['/workspace']);

    expect(invoke).not.toHaveBeenCalled();
    expect(isPreviewAssetScopeGranted(['/workspace'])).toBe(false);
  });

  it('reports granted only when every directory is covered', async () => {
    const { allowPreviewAssetScope, isPreviewAssetScopeGranted } =
      await loadScope();

    await allowPreviewAssetScope(['/workspace']);

    expect(isPreviewAssetScopeGranted(['/workspace'])).toBe(true);
    expect(isPreviewAssetScopeGranted(['/workspace', '/workspace/docs'])).toBe(
      false
    );
    expect(isPreviewAssetScopeGranted([])).toBe(true);
  });
});
