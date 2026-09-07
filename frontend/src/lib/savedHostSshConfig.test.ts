import { describe, expect, it } from 'vitest';

import {
  formatSshHostConfig,
  mentionedHostFileNames,
  sshHostAlias,
  sshHostFileName,
  sshHostWorkspacePath,
  sshTargetFromProvision,
} from './savedHostSshConfig';

describe('savedHostSshConfig', () => {
  it('formats a secret-free ssh config for a saved Host', () => {
    expect(
      formatSshHostConfig('Lab', {
        alias: 'lab',
        host: '203.0.113.8',
        user: 'root',
        port: 22,
        jump: 'bastion',
      })
    ).toBe(
      [
        '# VibeX Host: Lab',
        'Host lab',
        '  HostName 203.0.113.8',
        '  User root',
        '  Port 22',
        '  ProxyJump bastion',
        '',
      ].join('\n')
    );
  });

  it('builds a stable file name and workspace path', () => {
    expect(sshHostAlias('Root @ Lab')).toBe('root-lab');
    expect(sshHostFileName('Lab', 'ssh-lab-id')).toBe('lab-sshlabid.sshconfig');
    expect(sshHostWorkspacePath('lab-sshlabid.sshconfig')).toBe(
      '.vibex/ssh-hosts/lab-sshlabid.sshconfig'
    );
  });

  it('reads SSH targets from provision metadata without secrets', () => {
    expect(
      sshTargetFromProvision({
        host: '203.0.113.8',
        user: 'root',
        port: 22,
        password: 'secret',
      })
    ).toEqual({ host: '203.0.113.8', user: 'root', port: 22, jump: undefined });
    expect(sshTargetFromProvision({ host: '203.0.113.8' })).toBeNull();
  });

  it('collects mentioned Host files from composer tokens', () => {
    expect(
      mentionedHostFileNames(
        'deploy [@:Lab](.vibex/ssh-hosts/lab-abc.sshconfig) and [@:本机](.vibex/ssh-hosts/local.sshconfig)'
      )
    ).toEqual(['lab-abc.sshconfig', 'local.sshconfig']);
    expect(
      mentionedHostFileNames('[@:x](.vibex/ssh-hosts/../etc/passwd)')
    ).toEqual([]);
  });
});
