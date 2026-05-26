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
import { loadHistoricExecutionProcessEntries } from './conversationHistoricEntriesLoader';

vi.mock('@/utils/streamJsonPatchEntries', () => ({
  streamJsonPatchEntries: vi.fn(),
}));

function codingProcess(status: ExecutionProcessStatus): ExecutionProcess {
  return {
    id: 'coding-1',
    session_id: 'session-1',
    run_reason: 'codingagent',
    executor_action: {
      typ: {
        type: 'CodingAgentInitialRequest',
        prompt: 'historic prompt',
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
      status === ExecutionProcessStatus.completed
        ? '2026-05-26T00:00:05.000Z'
        : null,
    created_at: '2026-05-26T00:00:00.000Z',
    updated_at: '2026-05-26T00:00:05.000Z',
  };
}

function scriptProcess(): ExecutionProcess {
  return {
    ...codingProcess(ExecutionProcessStatus.completed),
    id: 'script-1',
    run_reason: 'setupscript',
    executor_action: {
      typ: {
        type: 'ScriptRequest',
        script: 'echo setup',
        language: 'Bash',
        context: 'SetupScript',
        working_dir: null,
      },
      next_action: null,
    },
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

function mockStream() {
  const close = vi.fn();
  let options: StreamOptions<PatchType> | undefined;

  vi.mocked(streamJsonPatchEntries).mockImplementation((_params, opts) => {
    options = opts as StreamOptions<PatchType>;
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
    get options() {
      if (!options) {
        throw new Error('stream options were not captured');
      }
      return options;
    },
  };
}

describe('conversationHistoricEntriesLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads completed coding-agent entries through the normalized stream', async () => {
    const stream = mockStream();
    const loadPromise = loadHistoricExecutionProcessEntries(
      codingProcess(ExecutionProcessStatus.completed)
    );
    const entries = [assistantPatch('done')];

    stream.options.onFinished?.(entries);

    await expect(loadPromise).resolves.toEqual(entries);
    expect(streamJsonPatchEntries).toHaveBeenCalledWith(
      {
        executionProcessId: 'coding-1',
        normalized: true,
      },
      expect.any(Object)
    );
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it('loads script entries through the raw stream', async () => {
    const stream = mockStream();
    const loadPromise = loadHistoricExecutionProcessEntries(scriptProcess());
    const entries = [assistantPatch('raw output')];

    stream.options.onFinished?.(entries);

    await expect(loadPromise).resolves.toEqual(entries);
    expect(streamJsonPatchEntries).toHaveBeenCalledWith(
      {
        executionProcessId: 'script-1',
        normalized: false,
      },
      expect.any(Object)
    );
  });

  it('settles running snapshots after the short idle timeout', async () => {
    vi.useFakeTimers();
    const stream = mockStream();
    const loadPromise = loadHistoricExecutionProcessEntries(
      codingProcess(ExecutionProcessStatus.running)
    );
    const entries = [assistantPatch('partial')];

    stream.options.onEntries?.(entries);
    await vi.advanceTimersByTimeAsync(49);

    let settled = false;
    loadPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(loadPromise).resolves.toEqual(entries);
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it('falls back to the latest entries when the historic stream errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stream = mockStream();
    const loadPromise = loadHistoricExecutionProcessEntries(
      codingProcess(ExecutionProcessStatus.completed)
    );
    const entries = [assistantPatch('before error')];

    stream.options.onEntries?.(entries);
    stream.options.onError?.(new Error('stream failed'));

    await expect(loadPromise).resolves.toEqual(entries);
    expect(stream.close).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'Error loading entries for historic execution process coding-1',
      expect.any(Error)
    );
    warnSpy.mockRestore();
  });
});
