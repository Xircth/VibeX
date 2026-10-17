import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceTerminal } from './openWorkspaceTerminal';

const { desktopShellCall } = vi.hoisted(() => ({
  desktopShellCall: vi.fn(),
}));

vi.mock('@/lib/desktopShell', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/desktopShell')>(
      '@/lib/desktopShell'
    );
  return { ...actual, desktopShellCall };
});

describe('openWorkspaceTerminal', () => {
  beforeEach(() => {
    desktopShellCall.mockReset();
    desktopShellCall.mockResolvedValue(undefined);
  });

  it('opens the chosen shell in an editor tab', () => {
    const openInEditor = vi.fn();

    openWorkspaceTerminal({
      shell: 'cmd.exe',
      defaultShell: 'powershell.exe',
      workspaceId: 'ws',
      openInEditor,
      onExternalError: vi.fn(),
    });

    expect(openInEditor).toHaveBeenCalledWith('cmd.exe');
    expect(desktopShellCall).not.toHaveBeenCalled();
  });

  it('uses the default shell when the menu row does not name one', () => {
    const openInEditor = vi.fn();

    openWorkspaceTerminal({
      defaultShell: 'powershell.exe',
      workspaceId: null,
      openInEditor,
      onExternalError: vi.fn(),
    });

    expect(openInEditor).toHaveBeenCalledWith('powershell.exe');
  });

  it('opens Warp outside the editor', () => {
    const openInEditor = vi.fn();
    const onExternalError = vi.fn();

    openWorkspaceTerminal({
      shell: 'warp',
      defaultShell: 'zsh',
      workspaceId: 'ws-1',
      openInEditor,
      onExternalError,
    });

    expect(openInEditor).not.toHaveBeenCalled();
    expect(desktopShellCall).toHaveBeenCalledWith('open_external_terminal', {
      workspaceId: 'ws-1',
      terminal: 'warp',
    });
  });

  it('does not open Warp without a workspace', () => {
    const openInEditor = vi.fn();

    openWorkspaceTerminal({
      shell: 'warp',
      defaultShell: 'zsh',
      workspaceId: null,
      openInEditor,
      onExternalError: vi.fn(),
    });

    expect(openInEditor).not.toHaveBeenCalled();
    expect(desktopShellCall).not.toHaveBeenCalled();
  });
});
