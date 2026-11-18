import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearLocalStorageCache } from '@/lib/safeStorage';

import {
  commitIdleReminder,
  MOBILE_IDLE_REMINDER_ARM_MS,
  MOBILE_IDLE_REMINDER_COOLDOWN_MS,
  MobileDeviceConnectBanner,
} from './MobileDeviceConnectBanner';

const openSettingsMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/lib/api/settingsWindow', () => ({
  settingsWindowApi: {
    open: openSettingsMock,
  },
}));

const listConnectRequestsMock = vi.fn();
const respondConnectRequestMock = vi.fn();
const listDevicesMock = vi.fn();

vi.mock('@/lib/desktopShell', () => ({
  isLocalDesktopHost: () => true,
}));

vi.mock('@/lib/api/config', () => ({
  webServiceApi: {
    listConnectRequests: (...args: unknown[]) =>
      listConnectRequestsMock(...args),
    respondConnectRequest: (...args: unknown[]) =>
      respondConnectRequestMock(...args),
    listDevices: (...args: unknown[]) => listDevicesMock(...args),
  },
}));

const offlinePhone = {
  device_id: 'dev-sgt',
  device_name: 'SGT-AL10',
  scopes: ['companion'],
  created_at: '2026-11-01T00:00:00Z',
  preset: 'companion' as const,
  client_kind: 'mobile' as const,
  last_connected_at: '2026-11-01T00:00:00Z',
};

describe('MobileDeviceConnectBanner', () => {
  beforeEach(() => {
    listConnectRequestsMock.mockReset();
    respondConnectRequestMock.mockReset();
    listDevicesMock.mockReset();
    listDevicesMock.mockResolvedValue([]);
    openSettingsMock.mockClear();
    localStorage.clear();
    clearLocalStorageCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when there are no pending mobile connection requests', async () => {
    listConnectRequestsMock.mockResolvedValue([]);
    render(<MobileDeviceConnectBanner />);
    await waitFor(() => {
      expect(listConnectRequestsMock).toHaveBeenCalled();
    });
    expect(
      screen.queryByTestId('mobile-device-connect-banner')
    ).not.toBeInTheDocument();
  });

  it('displays available mobile device with 4-digit SAS code and approves connection on click', async () => {
    listConnectRequestsMock.mockResolvedValue([
      {
        request_id: 'req-123',
        device_name: 'Pixel 9 Pro',
        client_kind: 'mobile',
        ip_address: '192.168.1.88',
        sas_code: '8392',
        created_at: '2026-11-09T05:00:00Z',
        expires_at: '2026-11-09T05:03:00Z',
      },
    ]);
    respondConnectRequestMock.mockResolvedValue(undefined);

    render(<MobileDeviceConnectBanner />);

    expect(
      await screen.findByText(/发现可用移动设备「Pixel 9 Pro」/)
    ).toBeInTheDocument();
    expect(screen.getByText('核对码 8392')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '连接' }));

    await waitFor(() => {
      expect(respondConnectRequestMock).toHaveBeenCalledWith('req-123', true);
    });
    expect(
      await screen.findByText(/已连接移动设备「Pixel 9 Pro」/)
    ).toBeInTheDocument();
  });

  it('shows an offline paired phone once, then stays quiet for the cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
    listConnectRequestsMock.mockResolvedValue([]);
    listDevicesMock.mockResolvedValue([offlinePhone]);

    const first = render(<MobileDeviceConnectBanner />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByText(/已配对手机「SGT-AL10」尚未连接/)
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(MOBILE_IDLE_REMINDER_ARM_MS);
    });
    first.unmount();

    render(<MobileDeviceConnectBanner />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText(/尚未连接/)).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('mobile-device-connect-banner')
    ).not.toBeInTheDocument();
  });

  it('hides the offline reminder immediately when ignored, including after remount', async () => {
    listConnectRequestsMock.mockResolvedValue([]);
    listDevicesMock.mockResolvedValue([offlinePhone]);

    const first = render(<MobileDeviceConnectBanner />);
    expect(
      await screen.findByText(/已配对手机「SGT-AL10」尚未连接/)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '忽略未连接提醒' }));
    expect(screen.queryByText(/尚未连接/)).not.toBeInTheDocument();
    first.unmount();

    render(<MobileDeviceConnectBanner />);
    await waitFor(() => {
      expect(listDevicesMock.mock.calls.length).toBeGreaterThan(1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/尚未连接/)).not.toBeInTheDocument();
  });

  it('opens remote connection settings and dismisses the offline reminder', async () => {
    listConnectRequestsMock.mockResolvedValue([]);
    listDevicesMock.mockResolvedValue([offlinePhone]);

    render(<MobileDeviceConnectBanner />);
    expect(
      await screen.findByText(/已配对手机「SGT-AL10」尚未连接/)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '查看连接' }));

    expect(openSettingsMock).toHaveBeenCalledWith('/settings/web-service');
    expect(screen.queryByText(/尚未连接/)).not.toBeInTheDocument();
  });

  it('shows the offline reminder again after the cooldown expires', async () => {
    commitIdleReminder(
      offlinePhone.device_id,
      Date.now() - MOBILE_IDLE_REMINDER_COOLDOWN_MS - 1000
    );
    listConnectRequestsMock.mockResolvedValue([]);
    listDevicesMock.mockResolvedValue([offlinePhone]);

    render(<MobileDeviceConnectBanner />);

    expect(
      await screen.findByText(/已配对手机「SGT-AL10」尚未连接/)
    ).toBeInTheDocument();
  });

  it('stays quiet while that phone connected recently', async () => {
    listConnectRequestsMock.mockResolvedValue([]);
    listDevicesMock.mockResolvedValue([
      {
        ...offlinePhone,
        last_connected_at: new Date().toISOString(),
      },
    ]);

    render(<MobileDeviceConnectBanner />);
    await waitFor(() => {
      expect(listDevicesMock).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/尚未连接/)).not.toBeInTheDocument();
  });

  it('still shows an active connect request while the offline reminder is snoozed', async () => {
    commitIdleReminder(offlinePhone.device_id);
    listDevicesMock.mockResolvedValue([offlinePhone]);
    listConnectRequestsMock.mockResolvedValue([
      {
        request_id: 'req-123',
        device_name: 'SGT-AL10',
        client_kind: 'mobile',
        ip_address: '192.168.1.88',
        sas_code: '8392',
        created_at: '2026-11-18T05:00:00Z',
        expires_at: '2026-11-18T05:03:00Z',
      },
    ]);

    render(<MobileDeviceConnectBanner />);

    expect(
      await screen.findByText(/发现可用移动设备「SGT-AL10」/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/尚未连接/)).not.toBeInTheDocument();
  });
});
