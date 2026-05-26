import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BaseCodingAgent,
  ExecutionProcessStatus,
  type ExecutionProcess,
  type PatchType,
} from 'shared/types';
import {
  streamJsonPatchEntries,
  type StreamOptions,
} from '@/utils/streamJsonPatchEntries';
import { loadRunningConversationStream } from './conversationRunningStream';
import type { PatchTypeWithKey } from './types';

vi.mock('@/utils/streamJsonPatchEntries', () => ({
  streamJsonPatchEntries: vi.fn(),
}));

function codingProcess(status = ExecutionProcessStatus.running): ExecutionProcess {
  return {
    id: 'process-running',
    session_id: 'session-1',
    run_reason: 'codingagent',
    executor_action: {
      typ: {
        type: 'CodingAgentInitialRequest',
        prompt: 'keep streaming',
        executor_profile_id: {
          executor: BaseCodingAgent.CODEX,
          variant: null,
        },
        working_dir: null,
      },
      next_action: null,
    },
    status,
    exit_code: status === ExecutionProcessStatus.completed ? 0n : null,
    dropped: false,
    started_at: '2026-05-26T00:00:00.000Z',
    completed_at:
      status === ExecutionProcessStatus.running
        ? null
        : '2026-05-26T00:00:05.000Z',
    created_at: '2026-05-26T00:00:00.000Z',
    updated_at: '2026-05-26T00:00:05.000Z',
  };
}

function assistantPatch(content: string): PatchType {
  return {
    type: 'NORMALIZED_ENTRY',
    content: {
      entry_type: { type: 'assistant_message' },
      content,
      timestamp: null,
    },
  };
}

function keyedPatch(content: string): PatchTypeWithKey {
  return {
    ...assistantPatch(content),
    patchKey: 'process-running:0',
    executionProcessId: 'process-running',
  };
}

function mockStream() {
  const close = vi.fn();
  const optionsByCall: StreamOptions<PatchType>[] = [];

  vi.mocked(streamJsonPatchEntries).mockImplementation((_params, opts) => {
    optionsByCall.push(opts as StreamOptions<PatchType>);
    return {
      getEntries: () => [],
      getSnapshot: () => ({ entries: [] }),
      isConnected: () => true,
      onChange: () => () => undefined,
      close,
    };
  });

  return {
    close,
    optionsByCall,
  };
}

function defaultOptions(overrides = {}) {
  return {
    executionProcess: codingProcess(),
    initialEntries: [],
    createStreamId: vi.fn((processId: string) => `stream:${processId}`),
    getLiveProcessStatus: vi.fn(() => ExecutionProcessStatus.completed),
    isLikelyStaleRunningSnapshot: vi.fn(() => false),
    onEntries: vi.fn(),
    onFinished: vi.fn(),
    closeExistingController: vi.fn(),
    setActiveController: vi.fn(),
    clearActiveController: vi.fn(),
    ...overrides,
  };
}

describe('conversationRunningStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards baseline entries, stream ids, and keyed streamed entries', async () => {
    const stream = mockStream();
    const initialEntries = [assistantPatch('cached')];
    const options = defaultOptions({ initialEntries });
    const loadPromise = loadRunningConversationStream(options);

    stream.optionsByCall[0]?.onEntries?.([assistantPatch('live')]);
    stream.optionsByCall[0]?.onFinished?.([]);

    await expect(loadPromise).resolves.toBeUndefined();
    expect(streamJsonPatchEntries).toHaveBeenCalledWith(
      {
        executionProcessId: 'process-running',
        normalized: true,
        streamId: 'stream:process-running',
      },
      expect.objectContaining({
        initial: {
          entries: initialEntries,
        },
      })
    );
    expect(options.closeExistingController).toHaveBeenCalledTimes(1);
    expect(options.setActiveController).toHaveBeenCalledTimes(1);
    expect(options.onEntries).toHaveBeenCalledWith([keyedPatch('live')]);
    expect(options.onFinished).toHaveBeenCalledTimes(1);
    expect(options.clearActiveController).toHaveBeenCalledTimes(1);
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it('suppresses stale running snapshots before mutating displayed state', async () => {
    const stream = mockStream();
    const options = defaultOptions({
      isLikelyStaleRunningSnapshot: vi.fn(() => true),
    });
    const loadPromise = loadRunningConversationStream(options);

    stream.optionsByCall[0]?.onEntries?.([assistantPatch('stale')]);
    stream.optionsByCall[0]?.onFinished?.([]);

    await expect(loadPromise).resolves.toBeUndefined();
    expect(options.onEntries).not.toHaveBeenCalled();
  });

  it('retries empty finished streams while the live process is still running', async () => {
    vi.useFakeTimers();
    const stream = mockStream();
    const options = defaultOptions({
      getLiveProcessStatus: vi.fn(() => ExecutionProcessStatus.running),
    });
    const loadPromise = loadRunningConversationStream(options);

    stream.optionsByCall[0]?.onFinished?.([]);
    expect(stream.close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(streamJsonPatchEntries).toHaveBeenCalledTimes(2);

    stream.optionsByCall[1]?.onEntries?.([assistantPatch('after retry')]);
    stream.optionsByCall[1]?.onFinished?.([]);

    await expect(loadPromise).resolves.toBeUndefined();
    expect(options.onEntries).toHaveBeenCalledWith([
      {
        ...assistantPatch('after retry'),
        patchKey: 'process-running:0',
        executionProcessId: 'process-running',
      },
    ]);
  });

  it('rejects and warns for non-retryable stream errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stream = mockStream();
    const options = defaultOptions();
    const loadPromise = loadRunningConversationStream(options);
    const err = new Error('stream failed');

    stream.optionsByCall[0]?.onError?.(err);

    await expect(loadPromise).rejects.toBe(err);
    expect(warnSpy).toHaveBeenCalledWith(
      'Error streaming entries for execution process process-running',
      err
    );
    expect(options.clearActiveController).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
