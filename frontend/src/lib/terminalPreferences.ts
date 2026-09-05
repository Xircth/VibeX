import type { Config } from 'shared/types';

import { getHostPlatform, type HostPlatform } from '@/utils/platform';

export type TerminalShellValue =
  | 'powershell.exe'
  | 'pwsh.exe'
  | 'cmd.exe'
  | 'bash.exe'
  | 'zsh'
  | 'bash'
  | 'sh'
  | 'warp';

export interface TerminalShellOption {
  value: TerminalShellValue;
  label: string;
  platforms: HostPlatform[];
}

type ConfigWithTerminalPreferences = Config & {
  default_terminal_shell?: string | null;
};

export const DEFAULT_TERMINAL_PANEL_HEIGHT = 200;

export const TERMINAL_SHELL_OPTIONS: TerminalShellOption[] = [
  { value: 'powershell.exe', label: 'PowerShell', platforms: ['windows'] },
  { value: 'pwsh.exe', label: 'PowerShell 7', platforms: ['windows'] },
  { value: 'cmd.exe', label: 'CMD', platforms: ['windows'] },
  { value: 'bash.exe', label: 'Git Bash', platforms: ['windows'] },
  { value: 'zsh', label: 'Zsh', platforms: ['macos', 'linux'] },
  { value: 'bash', label: 'Bash', platforms: ['macos', 'linux'] },
  { value: 'sh', label: 'sh', platforms: ['macos', 'linux'] },
  { value: 'warp', label: 'Warp', platforms: ['macos'] },
];

export function getTerminalShellOptions(
  platform = getHostPlatform()
): TerminalShellOption[] {
  const options = TERMINAL_SHELL_OPTIONS.filter((option) =>
    option.platforms.includes(platform)
  );

  if (options.length > 0) return options;
  return TERMINAL_SHELL_OPTIONS;
}

export function getPlatformDefaultTerminalShell(
  platform = getHostPlatform()
): TerminalShellValue {
  switch (platform) {
    case 'windows':
      return 'powershell.exe';
    case 'macos':
      return 'zsh';
    case 'linux':
      return 'bash';
    case 'unknown':
    default:
      return 'sh';
  }
}

export function normalizeTerminalShell(
  value: string | null | undefined,
  platform = getHostPlatform()
): TerminalShellValue {
  const options = getTerminalShellOptions(platform);
  const matched = options.find((option) => option.value === value);
  return matched?.value ?? getPlatformDefaultTerminalShell(platform);
}

export function getDefaultTerminalShell(
  config: Config | null | undefined
): TerminalShellValue {
  const platform = getHostPlatform();
  return normalizeTerminalShell(
    (config as ConfigWithTerminalPreferences | null | undefined)
      ?.default_terminal_shell,
    platform
  );
}

export function isExternalTerminalShell(
  value: TerminalShellValue | string | null | undefined
): boolean {
  return value === 'warp';
}

export function getTerminalWorkspaceKey(
  activeWorktreeId: string | null
): string | null {
  return activeWorktreeId;
}
