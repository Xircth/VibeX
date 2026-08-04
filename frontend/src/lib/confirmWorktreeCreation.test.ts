import { beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmWorktreeCreation } from './confirmWorktreeCreation';

const mocks = vi.hoisted(() => ({
  getCleanupStatus: vi.fn(),
  show: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  worktreeSettingsApi: { getCleanupStatus: mocks.getCleanupStatus },
}));

vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: { show: mocks.show },
}));

describe('confirmWorktreeCreation', () => {
  beforeEach(() => {
    mocks.getCleanupStatus.mockReset();
    mocks.show.mockReset();
  });

  it('continues without a dialog while the project is below its limit', async () => {
    mocks.getCleanupStatus.mockResolvedValue({
      current_count: 2,
      threshold: 4,
      should_prompt: false,
    });

    await expect(
      confirmWorktreeCreation('project-1', (key) => key)
    ).resolves.toBe(true);
    expect(mocks.show).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation when another worktree exceeds the limit', async () => {
    mocks.getCleanupStatus.mockResolvedValue({
      current_count: 4,
      threshold: 4,
      should_prompt: true,
    });
    mocks.show.mockResolvedValue('canceled');

    await expect(
      confirmWorktreeCreation('project-1', (key) => key)
    ).resolves.toBe(false);
    expect(mocks.show).toHaveBeenCalledTimes(1);
  });
});
