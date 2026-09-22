import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const show = vi.fn(async () => undefined);
const setFocus = vi.fn(async () => undefined);
const getCurrentWindow = vi.fn(() => ({ show, setFocus }));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow,
}));

vi.mock('@/utils/platform', () => ({
  isTauriDesktopShell: () =>
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
}));

import {
  revealDesktopWindow,
  revealDesktopWindowAfterPaint,
} from './revealDesktopWindow';

afterEach(() => {
  show.mockClear();
  setFocus.mockClear();
  getCurrentWindow.mockClear();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  window.history.replaceState({}, '', '/');
});

describe('revealDesktopWindow', () => {
  it('does nothing outside the desktop shell', async () => {
    await revealDesktopWindow();
    expect(getCurrentWindow).not.toHaveBeenCalled();
  });

  it('does not reveal the desktop-toast window', async () => {
    (
      window as Window & { __TAURI_INTERNALS__?: Record<string, never> }
    ).__TAURI_INTERNALS__ = {};
    window.history.replaceState({}, '', '/desktop-toast');
    await revealDesktopWindow();
    expect(getCurrentWindow).not.toHaveBeenCalled();
  });

  it('shows and focuses the current window after first paint', async () => {
    (
      window as Window & { __TAURI_INTERNALS__?: Record<string, never> }
    ).__TAURI_INTERNALS__ = {};

    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });

    const cancel = revealDesktopWindowAfterPaint();
    await vi.waitFor(() => {
      expect(show).toHaveBeenCalledTimes(1);
      expect(setFocus).toHaveBeenCalledTimes(1);
    });
    cancel();
    raf.mockRestore();
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
