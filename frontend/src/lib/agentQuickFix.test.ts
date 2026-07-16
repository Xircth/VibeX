import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  preflight: vi.fn(),
  runFix: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  agentSettingsApi: {
    preflight: mocks.preflight,
    runFix: mocks.runFix,
  },
}));

import { applyAgentQuickFix } from './agentQuickFix';

describe('applyAgentQuickFix', () => {
  it('installs the local CLI before ACP and skips the redundant ACP install', async () => {
    mocks.preflight.mockResolvedValue({
      checks: [
        { fixes: [{ action: 'install_npm' }] },
        { fixes: [{ action: 'install_cli' }] },
      ],
    });
    mocks.runFix.mockResolvedValue(undefined);

    const applied = await applyAgentQuickFix('codex');

    expect(mocks.runFix).toHaveBeenCalledTimes(1);
    expect(mocks.runFix).toHaveBeenCalledWith({
      agentType: 'codex',
      action: 'install_cli',
    });
    expect(applied).toBe(1);
  });
});
