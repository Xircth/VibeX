import { desktopShellCall } from '@/lib/desktopShell';
import { isExternalTerminalShell } from '@/lib/terminalPreferences';

export function openWorkspaceTerminal(input: {
  shell?: string;
  defaultShell: string;
  workspaceId: string | null;
  openInEditor: (shell: string) => void;
  onExternalError: (error: unknown) => void;
}): void {
  const chosen = input.shell ?? input.defaultShell;
  if (isExternalTerminalShell(chosen)) {
    if (!input.workspaceId) return;
    void desktopShellCall<void>('open_external_terminal', {
      workspaceId: input.workspaceId,
      terminal: chosen,
    }).catch(input.onExternalError);
    return;
  }
  input.openInEditor(chosen);
}
