import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentManagementApi } from '@/features/agent-management';

import { CodexDeviceLogin } from './CodexDeviceLogin';

describe('CodexDeviceLogin', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows the verification code and completes the inline login poll', async () => {
    vi.useFakeTimers();
    vi.spyOn(agentManagementApi, 'requestCodexDeviceCode').mockResolvedValue({
      user_code: 'ABCD-EFGH',
      verification_url: 'https://auth.openai.com/codex/device',
      device_auth_id: 'device-1',
      interval: 1,
    });
    vi.spyOn(agentManagementApi, 'pollCodexDeviceCode').mockResolvedValue({
      status: 'success',
      message: null,
    });
    const onAuthenticated = vi.fn();
    render(<CodexDeviceLogin onAuthenticated={onAuthenticated} />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: '使用设备码登录 Codex' })
      );
      await Promise.resolve();
    });
    expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(onAuthenticated).toHaveBeenCalledOnce();
    expect(screen.getByText('Codex 登录成功')).toBeInTheDocument();
  });
});
