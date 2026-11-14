import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileDeviceConnectBanner } from './MobileDeviceConnectBanner';

const listConnectRequestsMock = vi.fn();
const respondConnectRequestMock = vi.fn();
const listDevicesMock = vi.fn();
const revokeDeviceMock = vi.fn();

vi.mock('@/lib/desktopShell', () => ({
  isLocalDesktopHost: () => true,
}));

vi.mock('@/lib/frontendPreferences', () => ({
  writeDesktopSharedPreferenceSection: vi.fn(),
}));

vi.mock('@/lib/api/config', () => ({
  webServiceApi: {
    listConnectRequests: (...args: unknown[]) =>
      listConnectRequestsMock(...args),
    respondConnectRequest: (...args: unknown[]) =>
      respondConnectRequestMock(...args),
    listDevices: (...args: unknown[]) => listDevicesMock(...args),
    revokeDevice: (...args: unknown[]) => revokeDeviceMock(...args),
  },
}));

describe('MobileDeviceConnectBanner', () => {
  beforeEach(() => {
    listConnectRequestsMock.mockReset();
    respondConnectRequestMock.mockReset();
    listDevicesMock.mockReset();
    revokeDeviceMock.mockReset();
    listDevicesMock.mockResolvedValue([]);
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
        status: 'pending',
      },
    ]);
    respondConnectRequestMock.mockResolvedValue(undefined);

    render(<MobileDeviceConnectBanner />);

    expect(
      await screen.findByText(/发现可用移动设备「Pixel 9 Pro」/)
    ).toBeInTheDocument();
    expect(screen.getByText('连接码 8392')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '连接' }));

    await waitFor(() => {
      expect(respondConnectRequestMock).toHaveBeenCalledWith('req-123', true);
    });
    expect(
      await screen.findByText(/已连接移动设备「Pixel 9 Pro」/)
    ).toBeInTheDocument();
  });

  it('displays non-blocking connected notice with connection code and disconnect button for auto-approved same-account devices', async () => {
    listConnectRequestsMock.mockResolvedValue([
      {
        request_id: 'req-acct',
        device_name: 'iPhone 16 Pro',
        client_kind: 'mobile',
        sas_code: '1204',
        created_at: '2026-11-12T05:00:00Z',
        expires_at: '2026-11-12T05:03:00Z',
        account_display_name: 'Alice',
        status: 'approved',
        issued_device_id: 'dev-123',
      },
    ]);
    revokeDeviceMock.mockResolvedValue(undefined);

    render(<MobileDeviceConnectBanner />);

    expect(
      await screen.findByText(/已连接移动设备「iPhone 16 Pro」/)
    ).toBeInTheDocument();
    expect(screen.getByText('同账号 · Alice')).toBeInTheDocument();
    expect(screen.getByText('连接码 1204')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '断开' }));

    await waitFor(() => {
      expect(revokeDeviceMock).toHaveBeenCalledWith('dev-123');
    });
  });
});
