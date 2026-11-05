import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const show = vi.fn<() => Promise<void>>(async () => undefined);
const setFocus = vi.fn<() => Promise<void>>(async () => undefined);
const getCurrentWindow = vi.fn(() => ({ show, setFocus }));
const invoke = vi.fn<(cmd: string) => Promise<void>>(async () => undefined);

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
}));

vi.mock('@/utils/platform', () => ({
  isTauriDesktopShell: () =>
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
}));

import {
  revealDesktopWindow,
  revealDesktopWindowAfterPaint,
  revealDesktopWindowWithRetry,
} from './revealDesktopWindow';

afterEach(() => {
  show.mockReset();
  show.mockImplementation(async () => undefined);
  setFocus.mockReset();
  setFocus.mockImplementation(async () => undefined);
  getCurrentWindow.mockClear();
  invoke.mockReset();
  invoke.mockImplementation(async () => undefined);
  delete (window as Window & { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  window.history.replaceState({}, '', '/');
});

describe('revealDesktopWindow', () => {
  it('does nothing outside the desktop shell', async () => {
    await revealDesktopWindow();
    expect(getCurrentWindow).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not reveal the desktop-toast window', async () => {
    (
      window as Window & { __TAURI_INTERNALS__?: Record<string, never> }
    ).__TAURI_INTERNALS__ = {};
    window.history.replaceState({}, '', '/desktop-toast');
    await revealDesktopWindow();
    expect(getCurrentWindow).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('shows and focuses the current window after paint', async () => {
    (
      window as Window & { __TAURI_INTERNALS__?: Record<string, never> }
    ).__TAURI_INTERNALS__ = {};

    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });

    const cancel = revealDesktopWindowAfterPaint([0]);
    await vi.waitFor(() => {
      expect(show).toHaveBeenCalledTimes(1);
      expect(setFocus).toHaveBeenCalledTimes(1);
    });
    cancel();
    raf.mockRestore();
  });

  it('isolates setFocus failure so show still succeeds without throwing', async () => {
    (
      window as Window & { __TAURI_INTERNALS__?: Record<string, never> }
    ).__TAURI_INTERNALS__ = {};
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setFocus.mockRejectedValueOnce(new Error('focus denied by WM'));

    await expect(revealDesktopWindow()).resolves.toBeUndefined();
    expect(show).toHaveBeenCalledTimes(1);
    expect(setFocus).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[revealDesktopWindow] Window shown, but setFocus failed:',
      expect.any(Error)
    );
    warnSpy.mockRestore();
  });

  it('falls back to reveal_main_window command when current.show() fails', async () => {
    (
      window as Window & { __TAURI_INTERNALS__?: Record<string, never> }
    ).__TAURI_INTERNALS__ = {};
    show.mockRejectedValueOnce(new Error('window plugin unavailable'));

    await expect(revealDesktopWindow()).resolves.toBeUndefined();
    expect(show).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('reveal_main_window');
    expect(setFocus).toHaveBeenCalledTimes(1);
  });

  it('retries with backoff when both show() and fallback fail initially', async () => {
    (
      window as Window & { __TAURI_INTERNALS__?: Record<string, never> }
    ).__TAURI_INTERNALS__ = {};
    show
      .mockRejectedValueOnce(new Error('attempt 1 show failed'))
      .mockRejectedValueOnce(new Error('attempt 2 show failed'))
      .mockResolvedValueOnce(undefined);
    invoke
      .mockRejectedValueOnce(new Error('attempt 1 fallback failed'))
      .mockRejectedValueOnce(new Error('attempt 2 fallback failed'));

    const revealed = await revealDesktopWindowWithRetry([0, 5, 10]);
    expect(revealed).toBe(true);
    expect(show).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(setFocus).toHaveBeenCalledTimes(1);
  });

  it('logs a diagnostic warning when all retry attempts fail', async () => {
    (
      window as Window & { __TAURI_INTERNALS__?: Record<string, never> }
    ).__TAURI_INTERNALS__ = {};
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    show.mockRejectedValue(new Error('show failed'));
    invoke.mockRejectedValue(new Error('fallback failed'));

    const revealed = await revealDesktopWindowWithRetry([0, 5]);
    expect(revealed).toBe(false);
    expect(show).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      '[revealDesktopWindow] Failed to reveal desktop window after retries; relying on native fallback:',
      expect.any(Error)
    );
    warnSpy.mockRestore();
  });

  it('reveals from a dedicated entry before App hydrates', () => {
    const html = fs.readFileSync(
      path.resolve(__dirname, '../../index.html'),
      'utf8'
    );
    const entryIndex = html.indexOf('revealDesktopWindowEntry.ts');
    const appIndex = html.indexOf('main.tsx');
    expect(entryIndex).toBeGreaterThan(-1);
    expect(appIndex).toBeGreaterThan(entryIndex);
  });

  it('is allowed to show the desktop window', () => {
    const capability = fs.readFileSync(
      path.resolve(__dirname, '../../../src-tauri/capabilities/default.json'),
      'utf8'
    );
    expect(capability).toContain('core:window:allow-show');
  });
});
