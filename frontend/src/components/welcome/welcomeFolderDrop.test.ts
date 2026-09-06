import { describe, expect, it, vi } from 'vitest';

import {
  droppedFolderPath,
  resolveDroppedProjectFolder,
} from './welcomeFolderDrop';

describe('droppedFolderPath', () => {
  it('accepts exactly one non-empty path', () => {
    expect(droppedFolderPath(['/Users/mac/app'])).toBe('/Users/mac/app');
    expect(droppedFolderPath([])).toBeNull();
    expect(droppedFolderPath(['/a', '/b'])).toBeNull();
    expect(droppedFolderPath(['  '])).toBeNull();
  });
});

describe('resolveDroppedProjectFolder', () => {
  it('returns the path when listDirectory succeeds', async () => {
    const listDirectory = vi.fn().mockResolvedValue({ entries: [] });
    await expect(
      resolveDroppedProjectFolder(['/Users/mac/app'], listDirectory)
    ).resolves.toEqual({ ok: true, path: '/Users/mac/app' });
    expect(listDirectory).toHaveBeenCalledWith('/Users/mac/app');
  });

  it('rejects files and missing paths', async () => {
    const listDirectory = vi
      .fn()
      .mockRejectedValue(new Error('not a directory'));
    await expect(
      resolveDroppedProjectFolder(['/Users/mac/app/README.md'], listDirectory)
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
  });
});
