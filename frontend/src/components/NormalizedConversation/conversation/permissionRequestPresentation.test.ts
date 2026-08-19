import { describe, expect, it } from 'vitest';
import type { AgentPermissionOption } from 'shared/types';
import {
  permissionPreviewText,
  resolvePermissionAllowOption,
} from './permissionRequestPresentation';

function option(
  id: string,
  kind: AgentPermissionOption['kind']
): AgentPermissionOption {
  return { id, label: id, kind };
}

describe('resolvePermissionAllowOption', () => {
  const options = [
    option('deny', 'reject_once'),
    option('once', 'allow_once'),
    option('always', 'allow_always'),
  ];

  it('prefers allow_once for a one-shot approval', () => {
    expect(resolvePermissionAllowOption(options, 'once')?.id).toBe('once');
  });

  it('prefers allow_always for session and always-all scopes', () => {
    expect(resolvePermissionAllowOption(options, 'session')?.id).toBe('always');
    expect(resolvePermissionAllowOption(options, 'always')?.id).toBe('always');
  });

  it('falls back to the only allow option when kinds are missing', () => {
    expect(
      resolvePermissionAllowOption([option('only', 'allow_once')], 'always')?.id
    ).toBe('only');
  });
});

describe('permissionPreviewText', () => {
  it('joins a distinct title and command', () => {
    expect(
      permissionPreviewText({
        title: 'Run the project test command',
        command: 'pnpm test',
      })
    ).toBe('Run the project test command\npnpm test');
  });

  it('does not duplicate the same title and command', () => {
    expect(
      permissionPreviewText({
        title: 'pnpm test',
        command: 'pnpm test',
      })
    ).toBe('pnpm test');
  });
});
