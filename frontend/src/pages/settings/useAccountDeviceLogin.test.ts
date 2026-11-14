import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccountDeviceLogin } from './useAccountDeviceLogin';

const api = vi.hoisted(() => ({
  startLogin: vi.fn(),
  pollLogin: vi.fn(),
  openExternal: vi.fn(),
  resolveCurrentHostIdentity: vi.fn(),
}));
vi.mock('@/features/model-router', async (original) => ({
  ...(await original<typeof import('@/features/model-router')>()),
  accountApi: api,
  openExternal: api.openExternal,
  resolveCurrentHostIdentity: api.resolveCurrentHostIdentity,
}));

describe('browser account sign-in', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    api.startLogin.mockResolvedValue({
      requestId: 'request',
      verifier: 'secret',
      userCode: 'unused',
      verifyUrl: 'https://vibex.example/desktop/authorize?request=request',
      expiresIn: 30,
      interval: 1,
    });
    api.openExternal.mockResolvedValue(undefined);
    api.resolveCurrentHostIdentity.mockResolvedValue({
      hostId: 'host',
      hostName: 'Desktop',
    });
  });
  afterEach(() => vi.useRealTimers());
  it('opens the browser and refreshes the account after approval without code entry', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    api.pollLogin.mockResolvedValue(true);
    const { result } = renderHook(() =>
      useAccountDeviceLogin({ isSignedIn: false, refresh })
    );
    await act(() => result.current.startLogin());
    expect(api.openExternal).toHaveBeenCalledWith(
      'https://vibex.example/desktop/authorize?request=request'
    );
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.loginState).toBeNull();
  });
  it('cancels an in-flight poll and never starts overlapping polls', async () => {
    const refresh = vi.fn();
    let resolvePoll: (approved: boolean) => void = () => undefined;
    api.pollLogin.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePoll = resolve;
        })
    );
    const { result } = renderHook(() =>
      useAccountDeviceLogin({ isSignedIn: false, refresh })
    );
    await act(() => result.current.startLogin());
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(api.pollLogin).toHaveBeenCalledTimes(1);
    const signal = api.pollLogin.mock.calls[0][1];
    act(() => result.current.cancelLogin());
    expect(signal.aborted).toBe(true);
    await act(async () => resolvePoll(true));
    expect(refresh).not.toHaveBeenCalled();
    expect(result.current.loginState).toBeNull();
  });
  it('expires a stalled request and exposes a recoverable error', async () => {
    api.pollLogin.mockImplementation(() => new Promise(() => undefined));
    const { result } = renderHook(() =>
      useAccountDeviceLogin({ isSignedIn: false, refresh: vi.fn() })
    );
    await act(() => result.current.startLogin());
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(result.current.loginState).toBeNull();
    expect(result.current.authError).toBeTruthy();
  });
});
