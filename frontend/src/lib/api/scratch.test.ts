import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScratchType } from 'shared/types';

const backendCall = vi.hoisted(() => vi.fn());

vi.mock('./base', () => ({
  backendCall,
}));

import { scratchApi } from './misc';

describe('scratchApi', () => {
  beforeEach(() => {
    backendCall.mockReset();
    backendCall.mockResolvedValue({ kind: 'saved' });
  });

  it('sends UpdateScratch nested under payload for Host commands', async () => {
    await scratchApi.update(ScratchType.DRAFT_FOLLOW_UP, 'session-1', {
      payload: {
        type: 'DRAFT_FOLLOW_UP',
        data: {
          message: '',
          images: [],
          executor_config: { executor: 'codex' },
          queued: false,
          config_overrides: {},
        },
      },
    });

    expect(backendCall).toHaveBeenCalledWith('update_scratch', {
      scratchType: ScratchType.DRAFT_FOLLOW_UP,
      id: 'session-1',
      payload: {
        payload: {
          type: 'DRAFT_FOLLOW_UP',
          data: {
            message: '',
            images: [],
            executor_config: { executor: 'codex' },
            queued: false,
            config_overrides: {},
          },
        },
      },
    });
  });

  it('sends CreateScratch nested under payload for Host commands', async () => {
    await scratchApi.create(ScratchType.WORKSPACE_NOTES, 'session-1', {
      payload: {
        type: 'WORKSPACE_NOTES',
        data: { content: 'hello' },
      },
    });

    expect(backendCall).toHaveBeenCalledWith('create_scratch', {
      scratchType: ScratchType.WORKSPACE_NOTES,
      id: 'session-1',
      payload: {
        payload: {
          type: 'WORKSPACE_NOTES',
          data: { content: 'hello' },
        },
      },
    });
  });
});
