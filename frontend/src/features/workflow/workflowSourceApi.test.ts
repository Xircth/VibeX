import { describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/transport';

import {
  createWorkflowSourceApi,
  resolveWorkflowSourceRevision,
} from './workflowSourceApi';

function capturingTransport() {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const transport = {
    environment: 'desktop' as const,
    call: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args: args ?? {} });
      if (command === 'workflow_source_read') {
        throw new Error('not found');
      }
      return { revision: 'rev-2' };
    }),
  };
  return { transport: transport as unknown as BackendTransport, calls };
}

describe('resolveWorkflowSourceRevision', () => {
  it('keeps a known revision without reading the file', async () => {
    const { transport, calls } = capturingTransport();
    const api = createWorkflowSourceApi(transport);

    await expect(
      resolveWorkflowSourceRevision(api, '~/workflow.vibex-workflow.json', 'rev-1')
    ).resolves.toBe('rev-1');
    expect(calls).toHaveLength(0);
  });

  it('reads the current file when the editor has no known revision', async () => {
    const read = vi.fn().mockResolvedValue({
      path: '~/workflow.vibex-workflow.json',
      content: '{}',
      revision: 'rev-9',
    });
    const transport = {
      environment: 'desktop' as const,
      call: read,
    } as unknown as BackendTransport;
    const api = createWorkflowSourceApi(transport);

    await expect(
      resolveWorkflowSourceRevision(api, '~/workflow.vibex-workflow.json', null)
    ).resolves.toBe('rev-9');
    expect(read).toHaveBeenCalledWith('workflow_source_read', {
      path: '~/workflow.vibex-workflow.json',
    });
  });

  it('returns null when the file does not exist yet (fresh create)', async () => {
    const { transport } = capturingTransport();
    const api = createWorkflowSourceApi(transport);

    await expect(
      resolveWorkflowSourceRevision(api, '~/workflow.vibex-workflow.json', null)
    ).resolves.toBeNull();
  });

  it('writes with the resolved revision so existing sources are not refused', async () => {
    const read = vi.fn().mockResolvedValue({
      path: '~/workflow.vibex-workflow.json',
      content: '{}',
      revision: 'rev-9',
    });
    const write = vi.fn().mockResolvedValue({ revision: 'rev-10' });
    const transport = {
      environment: 'desktop' as const,
      call: vi.fn((command: string, args?: Record<string, unknown>) =>
        command === 'workflow_source_read' ? read() : write(args)
      ),
    } as unknown as BackendTransport;
    const api = createWorkflowSourceApi(transport);

    const expectedRevision = await resolveWorkflowSourceRevision(
      api,
      '~/workflow.vibex-workflow.json',
      null
    );
    await api.write(
      '~/workflow.vibex-workflow.json',
      '{"name":"updated"}',
      expectedRevision ?? undefined
    );

    expect(write).toHaveBeenCalledWith({
      path: '~/workflow.vibex-workflow.json',
      content: '{"name":"updated"}',
      expectedRevision: 'rev-9',
    });
  });
});
