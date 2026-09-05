import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TauriTransport } from './tauriTransport';

const { tauriInvoke, tauriListen } = vi.hoisted(() => ({
  tauriInvoke: vi.fn(),
  tauriListen: vi.fn(),
}));

vi.mock('@/lib/tauriApi', () => ({
  tauriInvoke,
  tauriListen,
}));

describe('TauriTransport application command adapter', () => {
  beforeEach(() => {
    tauriInvoke.mockReset();
    tauriListen.mockReset();
    tauriListen.mockResolvedValue(vi.fn());
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

  it('scopes streamed command output to its invocation channel', async () => {
    const onMessage = vi.fn();
    tauriInvoke.mockImplementation(async (_command, args) => {
      const channel = (
        args as { onEvent: { onmessage: (value: unknown) => void } }
      ).onEvent;
      channel.onmessage({ event: 'log', line: 'installed' });
      return { success: true };
    });

    await expect(
      new TauriTransport().stream(
        'plugin_control_import_cli',
        { ecosystem: 'codex', command: 'codex plugin add browser@official' },
        onMessage
      )
    ).resolves.toEqual({ success: true });

    expect(onMessage).toHaveBeenCalledWith({
      event: 'log',
      line: 'installed',
    });
    expect(tauriInvoke).toHaveBeenCalledWith('plugin_control_import_cli', {
      ecosystem: 'codex',
      command: 'codex plugin add browser@official',
      onEvent: expect.any(Object),
    });
  });

  it('preserves the desktop companion-aware question adapter', async () => {
    tauriInvoke.mockResolvedValue({
      operation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
      data: null,
    });
    const request = {
      conversationId: 'conversation-1',
      questionId: 'question-1',
      response: { outcome: 'cancel' as const },
    };

    await new TauriTransport().call('conversation_respond_question', {
      request,
    });

    expect(tauriInvoke).toHaveBeenCalledWith('application_call', {
      command: 'conversation_respond_question',
      operationId: expect.any(String),
      args: { request },
    });
  });

  it('rejects an outbound cursor that cannot round-trip through JSON safely', async () => {
    const events = new TauriTransport().subscribe({
      subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
      resource: 'conversation',
      conversation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f56',
      after_sequence: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    });

    await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow(
      'Conversation sequence exceeds JSON-safe integer range'
    );
    expect(tauriInvoke).not.toHaveBeenCalled();
  });

  it('rejects an unsafe sequence returned by the desktop wire', async () => {
    tauriInvoke.mockResolvedValue({
      subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
      ready: true,
      replay: [],
      high_water_mark: Number.MAX_SAFE_INTEGER + 1,
    });
    const events = new TauriTransport().subscribe({
      subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
      resource: 'conversation',
      conversation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f56',
      after_sequence: 0n,
    });

    await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow(
      'Backend returned a non-JSON-safe conversation sequence'
    );
  });
});
