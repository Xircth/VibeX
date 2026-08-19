import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UpdateAvailableBadge } from './UpdateAvailableBadge';

const mocks = vi.hoisted(() => ({
  checkAppUpdate: vi.fn(),
  readCachedAppUpdate: vi.fn(),
  subscribeAppUpdate: vi.fn(() => () => undefined),
  autoUpdateEnabled: true,
}));

vi.mock('@/lib/appUpdate', () => ({
  checkAppUpdate: (...args: unknown[]) => mocks.checkAppUpdate(...args),
  readCachedAppUpdate: () => mocks.readCachedAppUpdate(),
  subscribeAppUpdate: (...args: unknown[]) => mocks.subscribeAppUpdate(...args),
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    config: { auto_update_enabled: mocks.autoUpdateEnabled },
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

describe('UpdateAvailableBadge', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.autoUpdateEnabled = true;
    mocks.readCachedAppUpdate.mockReturnValue(null);
    mocks.checkAppUpdate.mockResolvedValue({ update: null });
  });

  it('does not check when automatic updates are disabled', async () => {
    mocks.autoUpdateEnabled = false;

    render(<UpdateAvailableBadge />);
    await Promise.resolve();

    expect(mocks.checkAppUpdate).not.toHaveBeenCalled();
  });

  it('uses the shared update check when automatic updates are on', async () => {
    mocks.checkAppUpdate.mockResolvedValue({
      update: { version: '0.1.3' },
    });

    render(<UpdateAvailableBadge />);

    await waitFor(() => expect(mocks.checkAppUpdate).toHaveBeenCalledOnce());
  });
});
