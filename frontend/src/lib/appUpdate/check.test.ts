import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  getVersion: vi.fn(() => Promise.resolve('0.37.0')),
  invoke: vi.fn((_command: string) => Promise.resolve()),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: mocks.check,
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: mocks.relaunch,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: mocks.getVersion,
}));

import {
  dismissAppUpdateVersion,
  getAppUpdateState,
  getDismissedAppUpdateVersion,
  installSignedUpdate,
  relaunchApp,
  resetAppUpdateStateForTests,
  subscribeAppUpdateState,
} from './check';
import {
  consumePostUpdateRestoreRoute,
  recordMainWindowRoute,
  writeDismissedVersion,
} from './storage';
import type { AppUpdateLifecycleState } from './types';

describe('appUpdate lifecycle state', () => {
  const originalUserAgent = navigator.userAgent;

  beforeEach(() => {
    mocks.check.mockReset();
    mocks.relaunch.mockReset();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
    resetAppUpdateStateForTests();
    writeDismissedVersion(null);
    window.localStorage.removeItem('dimo.appUpdate.lastMainRoute');
    window.localStorage.removeItem('dimo.appUpdate.postUpdateRestore');
  });

  afterEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
    });
  });

  it('tracks downloading bytes, installing, and ready_to_restart on non-Windows', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true,
    });

    const states: AppUpdateLifecycleState[] = [];
    const unsubscribe = subscribeAppUpdateState((next) => {
      states.push({ ...next });
    });

    const order: string[] = [];
    mocks.invoke.mockImplementation(async (command: string) => {
      order.push(command);
    });
    const install = vi.fn(async () => {
      order.push('install');
      expect(getAppUpdateState().status).toBe('installing');
    });
    const close = vi.fn(async () => undefined);

    mocks.check.mockResolvedValue({
      version: '0.39.0',
      download: vi.fn(async (onEvent) => {
        onEvent({ event: 'Started', data: { contentLength: 4000 } });
        onEvent({ event: 'Progress', data: { chunkLength: 1000 } });
        onEvent({ event: 'Progress', data: { chunkLength: 3000 } });
        onEvent({ event: 'Finished' });
      }),
      install,
      close,
    });

    const progresses: number[] = [];
    await installSignedUpdate((p) => progresses.push(p));
    unsubscribe();

    expect(progresses).toEqual([0, 25, 100, 100]);
    expect(order).toEqual(['evacuate_user_data_before_update', 'install']);
    expect(install).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(states.map((s) => s.status)).toEqual([
      'downloading',
      'downloading',
      'downloading',
      'downloading',
      'installing',
      'ready_to_restart',
    ]);
    expect(getAppUpdateState()).toEqual({
      status: 'ready_to_restart',
      version: '0.39.0',
      downloaded: 4000,
      total: 4000,
      error: null,
    });
  });

  it('stages download on Windows and defers install until relaunchApp is called', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true,
    });

    recordMainWindowRoute(
      '/local-projects/project-1/workspaces/workspace-1/sessions/session-1'
    );

    const download = vi.fn(async (onEvent) => {
      onEvent({ event: 'Started', data: { contentLength: 2048 } });
      onEvent({ event: 'Progress', data: { chunkLength: 2048 } });
      onEvent({ event: 'Finished' });
    });
    const install = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);

    mocks.check.mockResolvedValue({
      version: '0.39.0',
      download,
      install,
      close,
    });

    await installSignedUpdate();

    expect(download).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(getAppUpdateState().status).toBe('ready_to_restart');

    const order: string[] = [];
    mocks.invoke.mockImplementation(async (command: string) => {
      order.push(command);
    });
    install.mockImplementation(async () => {
      order.push('install');
    });

    await relaunchApp();

    expect(order).toEqual(['evacuate_user_data_before_update', 'install']);
    expect(install).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(getAppUpdateState().status).toBe('restarting');
    expect(consumePostUpdateRestoreRoute()).toBe(
      '/local-projects/project-1/workspaces/workspace-1/sessions/session-1'
    );
  });

  it('records error state when download fails', async () => {
    mocks.check.mockResolvedValue({
      version: '0.39.0',
      download: vi.fn(async () => {
        throw new Error('network timeout');
      }),
      install: vi.fn(),
      close: vi.fn(async () => undefined),
    });

    await expect(installSignedUpdate()).rejects.toThrow('network timeout');
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(getAppUpdateState()).toEqual({
      status: 'error',
      version: '0.39.0',
      downloaded: 0,
      total: null,
      error: 'network timeout',
    });
  });

  it('does not install when evacuating session data fails', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true,
    });
    const install = vi.fn(async () => undefined);
    mocks.invoke.mockRejectedValue(new Error('still inside bundle'));
    mocks.check.mockResolvedValue({
      version: '0.39.0',
      download: vi.fn(async (onEvent) => {
        onEvent({ event: 'Finished' });
      }),
      install,
      close: vi.fn(async () => undefined),
    });

    await expect(installSignedUpdate()).rejects.toThrow('still inside bundle');
    expect(install).not.toHaveBeenCalled();
    expect(getAppUpdateState().status).toBe('error');
    expect(getAppUpdateState().error).toBe('still inside bundle');
  });

  it('does not relaunch on Windows when evacuating session data fails', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true,
    });
    const install = vi.fn(async () => undefined);
    mocks.check.mockResolvedValue({
      version: '0.39.0',
      download: vi.fn(async (onEvent) => {
        onEvent({ event: 'Finished' });
      }),
      install,
      close: vi.fn(async () => undefined),
    });

    await installSignedUpdate();
    mocks.invoke.mockRejectedValue(new Error('still inside bundle'));

    await expect(relaunchApp()).rejects.toThrow('still inside bundle');
    expect(install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(getAppUpdateState().status).toBe('error');
  });

  it('persists and broadcasts dismissed update version', () => {
    expect(getDismissedAppUpdateVersion()).toBeNull();
    dismissAppUpdateVersion('0.39.0');
    expect(getDismissedAppUpdateVersion()).toBe('0.39.0');
    dismissAppUpdateVersion(null);
    expect(getDismissedAppUpdateVersion()).toBeNull();
  });
});
