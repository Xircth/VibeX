import type { Config } from 'shared/types';

export type TerminalShellValue = '' | 'powershell.exe' | 'cmd.exe' | 'bash';

export interface TerminalShellOption {
  value: TerminalShellValue;
  label: string;
}

type ConfigWithTerminalPreferences = Config & {
  default_terminal_shell?: string | null;
};

export const DEFAULT_TERMINAL_PANEL_HEIGHT = 200;

export const TERMINAL_SHELL_OPTIONS: TerminalShellOption[] = [
  { value: '', label: 'Default' },
  { value: 'powershell.exe', label: 'PowerShell' },
  { value: 'cmd.exe', label: 'CMD' },
  { value: 'bash', label: 'Bash' },
];

export function normalizeTerminalShell(
  value: string | null | undefined
): TerminalShellValue {
  switch (value) {
    case 'powershell.exe':
    case 'cmd.exe':
    case 'bash':
      return value;
    default:
      return '';
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
