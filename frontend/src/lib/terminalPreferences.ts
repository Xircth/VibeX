import type { Config } from 'shared/types';

export type TerminalShellValue = 'powershell.exe' | 'cmd.exe';

export interface TerminalShellOption {
  value: TerminalShellValue;
  label: string;
}

type ConfigWithTerminalPreferences = Config & {
  default_terminal_shell?: string | null;
};

export const DEFAULT_TERMINAL_PANEL_HEIGHT = 200;

export const TERMINAL_SHELL_OPTIONS: TerminalShellOption[] = [
  { value: 'powershell.exe', label: 'PowerShell' },
  { value: 'cmd.exe', label: 'CMD' },
];

export function normalizeTerminalShell(
  value: string | null | undefined
): TerminalShellValue {
  switch (value) {
    case 'cmd.exe':
      return value;
    case 'powershell.exe':
    default:
      return 'powershell.exe';
  }
}

export function getDefaultTerminalShell(
  config: Config | null | undefined
): TerminalShellValue {
  return normalizeTerminalShell(
    (config as ConfigWithTerminalPreferences | null | undefined)
      ?.default_terminal_shell
  );
}

export function getTerminalWorkspaceKey(
  activeWorktreeId: string | null
): string | null {
  return activeWorktreeId;
}
