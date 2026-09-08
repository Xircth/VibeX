import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from '@/components/ui/toast';

import { useRemoteHostReleaseUpdateToast } from './useRemoteHostReleaseUpdateToast';

const hostClientApiMock = vi.hoisted(() => ({
  status: vi.fn(),
  hostUpdates: vi.fn(),
}));

const settingsWindowApiMock = vi.hoisted(() => ({
  open: vi.fn(),
}));

const getCurrentWindow = vi.hoisted(() => vi.fn(() => ({ label: 'host-lab' })));

vi.mock('@/lib/api', () => ({
  hostClientApi: hostClientApiMock,
  settingsWindowApi: settingsWindowApiMock,
}));

vi.mock('@/lib/desktopShell', () => ({
  useTauriClient: () => true,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow,
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    warning: vi.fn(),
  },
}));

vi.mock('@/lib/tauriApi', () => ({
  tauriListen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { from?: string; to?: string }) =>
      key === 'webService.hostUpdateToast'
        ? `${options?.from} -> ${options?.to}`
        : key,
  }),
}));

function Harness() {
  useRemoteHostReleaseUpdateToast();
  return null;
}

describe('useRemoteHostReleaseUpdateToast', () => {
  beforeEach(() => {
    hostClientApiMock.status.mockReset();
    hostClientApiMock.hostUpdates.mockReset();
    settingsWindowApiMock.open.mockReset();
    getCurrentWindow.mockReset();
    getCurrentWindow.mockReturnValue({ label: 'host-lab' });
    vi.mocked(toast.warning).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('toasts when the connected Host is a published build behind latest', async () => {
    hostClientApiMock.status.mockResolvedValue({
      connected: true,
      profile: { id: 'lab', name: 'Lab' },
      profiles: [],
    });
    hostClientApiMock.hostUpdates.mockResolvedValue([
      {
        profile_id: 'lab',
        current_version: '0.2.0',
        latest_version: '0.2.1',
        update_available: true,
        reachable: true,
      },
    ]);
    render(<Harness />);
    await vi.waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(
        '0.2.0 -> 0.2.1',
        expect.objectContaining({
          action: expect.objectContaining({
            label: 'app:shell.viewUpdate',
          }),
        })
      );
    });
    const action = vi.mocked(toast.warning).mock.calls[0]?.[1]?.action;
    action?.onClick({} as never);
    expect(settingsWindowApiMock.open).toHaveBeenCalledWith(
      '/settings/web-service'
    );
  });

  it('does not toast when the connected Host has no published update', async () => {
    hostClientApiMock.status.mockResolvedValue({
      connected: true,
      profile: { id: 'lab', name: 'Lab' },
      profiles: [],
    });
    hostClientApiMock.hostUpdates.mockResolvedValue([
      {
        profile_id: 'lab',
        current_version: '0.2.1',
        latest_version: '0.2.1',
        update_available: false,
        reachable: true,
      },
    ]);
    render(<Harness />);
    await vi.waitFor(() => {
      expect(hostClientApiMock.hostUpdates).toHaveBeenCalled();
    });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('does not toast from the local App window', async () => {
    getCurrentWindow.mockReturnValue({ label: 'main' });
    hostClientApiMock.status.mockResolvedValue({
      connected: true,
      profile: { id: 'lab', name: 'Lab' },
      profiles: [],
    });
    render(<Harness />);
    await vi.waitFor(() => {
      expect(getCurrentWindow).toHaveBeenCalled();
    });
    expect(hostClientApiMock.status).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('does not toast when the Host window is not connected', async () => {
    hostClientApiMock.status.mockResolvedValue({
      connected: false,
      profile: null,
      profiles: [],
    });
    render(<Harness />);
    await vi.waitFor(() => {
      expect(hostClientApiMock.status).toHaveBeenCalled();
    });
    expect(hostClientApiMock.hostUpdates).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
