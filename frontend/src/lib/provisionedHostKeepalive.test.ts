import { describe, expect, it, vi } from 'vitest';

import { recoverBoundProvisionedHost } from './provisionedHostKeepalive';

describe('recoverBoundProvisionedHost', () => {
  it('does not rebuild an SSH tunnel when a bound Host probe fails', async () => {
    const notify = vi.fn();
    const connect = vi.fn();
    await expect(
      recoverBoundProvisionedHost({
        connected: true,
        profile: { id: 'ssh-1', provision_kind: 'ssh' },
        probe: async () => {
          throw new Error('offline');
        },
        connect,
        notify,
      })
    ).resolves.toBe('skipped');
    expect(notify).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});
