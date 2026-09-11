import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesktopWindowControls } from './DesktopWindowControls';

const useTauriClient = vi.hoisted(() => vi.fn(() => true));

vi.mock('@/lib/desktopShell', () => ({
  useTauriClient,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => undefined),
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }),
}));

describe('DesktopWindowControls', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useTauriClient.mockReturnValue(true);
  });

  it('renders minimize, maximize, and close on Windows desktop', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
    render(<DesktopWindowControls />);

    expect(
      screen.getByRole('button', { name: 'Minimize' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Maximize' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('does not let the Windows chrome overlay steal clicks outside the buttons', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
    render(<DesktopWindowControls />);

    const overlay = screen
      .getByRole('button', { name: 'Minimize' })
      .closest('.desktop-window-controls');
    expect(overlay).toHaveClass('pointer-events-none');
    expect(
      screen
        .getByRole('button', { name: 'Minimize' })
        .closest('.pointer-events-auto')
    ).not.toBeNull();
  });

  it('uses the same circular hover for minimize, maximize, and close', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
    render(<DesktopWindowControls />);

    for (const name of ['Minimize', 'Maximize', 'Close']) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveClass('rounded-full', 'h-7', 'w-7');
      expect(button.className).not.toContain('windows-close-hover');
    }
  });

  it('does not render window controls on macOS', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    render(<DesktopWindowControls />);

    expect(
      screen.queryByRole('button', { name: 'Minimize' })
    ).not.toBeInTheDocument();
  });

  it('does not render window controls on Web', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
    useTauriClient.mockReturnValue(false);
    render(<DesktopWindowControls />);

    expect(
      screen.queryByRole('button', { name: 'Minimize' })
    ).not.toBeInTheDocument();
  });
});
