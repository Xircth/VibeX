import { describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { createArtifactApi } from './artifacts';

describe('Artifact API', () => {
  it('keeps list and preview lifecycle behind the active transport', async () => {
    const call = vi.fn().mockResolvedValue([]);
    const api = createArtifactApi({
      environment: 'web',
      call,
    } satisfies BackendTransport);

    await api.list('conversation-1', 25);
    await api.openPreview('artifact-1');
    await api.closePreview('lease-1');

    expect(call.mock.calls).toEqual([
      ['artifact_list', { conversationId: 'conversation-1', limit: 25 }],
      ['artifact_open_preview', { artifactId: 'artifact-1' }],
      ['artifact_close_preview', { leaseId: 'lease-1' }],
    ]);
  });
});
