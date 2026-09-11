import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  backendCall: vi.fn(),
  backendListen: vi.fn(),
}));

vi.mock('@/lib/backendTransport', () => transport);

type StreamModule = typeof import('./fileTreeChangeStream');
type FileTreeChange = import('./fileTreeChangeStream').FileTreeChange;

/** The subscription registry is module state, so each test needs a fresh copy. */
async function loadStream(): Promise<StreamModule> {
  vi.resetModules();
  return import('./fileTreeChangeStream');
}

/** Handlers the module registered with the transport, in order. */
let delivered: ((payload: FileTreeChange) => void)[];

describe('fileTreeChangeStream', () => {
  beforeEach(() => {
    delivered = [];
    transport.backendCall.mockReset().mockResolvedValue(undefined);
    transport.backendListen
      .mockReset()
      .mockImplementation(
        async (_event: string, handler: (payload: FileTreeChange) => void) => {
          delivered.push(handler);
        }
      );
  });

  it('opens one subscription for every consumer of a root', async () => {
    const { subscribeFileTreeChanges } = await loadStream();
    const first = vi.fn();
    const second = vi.fn();

    const stopFirst = subscribeFileTreeChanges('/workspace', first);
    const stopSecond = subscribeFileTreeChanges('/workspace', second);

    expect(transport.backendCall).toHaveBeenCalledTimes(1);
    expect(transport.backendListen).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    delivered[0]({ root_path: '/workspace', added_paths: ['a.html'] });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    stopSecond();
  });

  it('keeps the subscription alive until the last consumer leaves', async () => {
    const dispose = vi.fn();
    transport.backendListen.mockResolvedValue(dispose);
    const { subscribeFileTreeChanges } = await loadStream();

    const stopFirst = subscribeFileTreeChanges('/workspace', vi.fn());
    const stopSecond = subscribeFileTreeChanges('/workspace', vi.fn());
    await vi.waitFor(() => expect(transport.backendListen).toHaveBeenCalled());

    stopFirst();
    expect(dispose).not.toHaveBeenCalled();

    stopSecond();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('stops delivering to a consumer that unsubscribed', async () => {
    const { subscribeFileTreeChanges } = await loadStream();
    const stays = vi.fn();
    const leaves = vi.fn();

    subscribeFileTreeChanges('/workspace', stays);
    const stopLeaving = subscribeFileTreeChanges('/workspace', leaves);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));

    stopLeaving();
    delivered[0]({ root_path: '/workspace' });

    expect(stays).toHaveBeenCalledTimes(1);
    expect(leaves).not.toHaveBeenCalled();
  });

  it('ignores roots the consumer did not ask for', async () => {
    const { subscribeFileTreeChanges } = await loadStream();
    const workspace = vi.fn();

    subscribeFileTreeChanges('/workspace', workspace);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));

    // A trailing separator names the same directory.
    delivered[0]({ root_path: '/workspace/' });
    expect(workspace).toHaveBeenCalledTimes(1);

    delivered[0]({ root_path: '/elsewhere' });
    expect(workspace).toHaveBeenCalledTimes(1);
  });

  it('normalizes separators and trailing slashes', async () => {
    const { normalizeWatchedPath } = await loadStream();

    expect(normalizeWatchedPath('/workspace/')).toBe('/workspace');
    expect(normalizeWatchedPath('C:\\work\\repo\\')).toBe('C:/work/repo');
  });

  it('resubscribes after every consumer of a root has gone', async () => {
    const { subscribeFileTreeChanges } = await loadStream();

    const stop = subscribeFileTreeChanges('/workspace', vi.fn());
    await vi.waitFor(() => expect(delivered).toHaveLength(1));

    stop();

    subscribeFileTreeChanges('/workspace', vi.fn());
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    expect(delivered[1]).not.toBe(delivered[0]);
  });
});
