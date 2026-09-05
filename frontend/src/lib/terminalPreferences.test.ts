import { describe, expect, it } from 'vitest';

import {
  getPlatformDefaultTerminalShell,
  getTerminalShellOptions,
  normalizeTerminalShell,
} from './terminalPreferences';

describe('terminalPreferences', () => {
  it('lists Windows shells including Git Bash as an explicit option', () => {
    expect(
      getTerminalShellOptions('windows').map((option) => option.value)
    ).toEqual(['powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe']);
  });

  it('keeps PowerShell as the unset Windows default', () => {
    expect(getPlatformDefaultTerminalShell('windows')).toBe('powershell.exe');
  });

  it('accepts Git Bash when the host is Windows', () => {
    expect(normalizeTerminalShell('bash.exe', 'windows')).toBe('bash.exe');
  });

  it('does not treat Git Bash as a macOS or Linux picker value', () => {
    expect(normalizeTerminalShell('bash.exe', 'macos')).toBe('zsh');
    expect(normalizeTerminalShell('bash.exe', 'linux')).toBe('bash');
  });
});
