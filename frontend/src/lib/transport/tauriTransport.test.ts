import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TauriTransport } from './tauriTransport';

const { tauriInvoke } = vi.hoisted(() => ({
  tauriInvoke: vi.fn(),
}));

vi.mock('@/lib/tauriApi', () => ({
  tauriInvoke,
  tauriListen: vi.fn(),
}));

describe('TauriTransport application command adapter', () => {
  beforeEach(() => {
    tauriInvoke.mockReset();
  });

  it('routes the conversation tracer through the closed command registry', async () => {
    tauriInvoke.mockResolvedValue({
      operation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
      data: [{ id: 'conversation-1' }],
    });

    await expect(
      new TauriTransport().call('conversation_list', {
        workspaceId: 'workspace-1',
      })
    ).resolves.toEqual([{ id: 'conversation-1' }]);

    expect(tauriInvoke).toHaveBeenCalledWith('application_call', {
      command: 'conversation_list',
      operationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      args: { workspaceId: 'workspace-1' },
    });
  });

  it('keeps legacy desktop commands on the explicit Tauri handler table', async () => {
    tauriInvoke.mockResolvedValue('ok');

    await expect(new TauriTransport().call('health_check')).resolves.toBe('ok');
    expect(tauriInvoke).toHaveBeenCalledWith('health_check', undefined);
  });
});
