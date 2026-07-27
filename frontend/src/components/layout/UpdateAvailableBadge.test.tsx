import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UpdateAvailableBadge } from './UpdateAvailableBadge';

const checkMock = vi.fn();

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: checkMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

describe('UpdateAvailableBadge', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('does not contact the updater endpoint in a development build', async () => {
    vi.stubEnv('DEV', true);

    render(<UpdateAvailableBadge />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(checkMock).not.toHaveBeenCalled();
  });

  it('checks for updates in a packaged build', async () => {
    vi.stubEnv('DEV', false);
    checkMock.mockResolvedValue(null);

    render(<UpdateAvailableBadge />);

    await waitFor(() => expect(checkMock).toHaveBeenCalledOnce());
  });
});
