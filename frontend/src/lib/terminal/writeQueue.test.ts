import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWriteQueue } from './writeQueue';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function controllableSend() {
  const batches: string[] = [];
  const gates: Deferred[] = [];
  let inFlight = 0;
  let peak = 0;
  const send = async (data: string): Promise<void> => {
    batches.push(data);
    const gate = deferred();
    gates.push(gate);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      await gate.promise;
    } finally {
      inFlight -= 1;
    }
  };
  return {
    send,
    batches,
    resolveAt: (i: number) => gates[i].resolve(),
    rejectAt: (i: number, err: unknown) => gates[i].reject(err),
    peakInFlight: () => peak,
  };
}

const pump = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWriteQueue', () => {
  it('coalesces bytes typed during an in-flight send into the next batch', async () => {
    const c = controllableSend();
    const q = createWriteQueue(c.send);

    q.enqueue('a');
    expect(c.batches).toEqual(['a']);
    q.enqueue('b');
    q.enqueue('c');
    expect(c.batches).toEqual(['a']);

    c.resolveAt(0);
    await pump();
    expect(c.batches).toEqual(['a', 'bc']);

    q.dispose();
  });

  it('never has more than one send in flight', async () => {
    const c = controllableSend();
    const q = createWriteQueue(c.send);

    q.enqueue('a');
    q.enqueue('b');
    q.enqueue('c');
    c.resolveAt(0);
    await pump();
    c.resolveAt(1);
    await pump();

    expect(c.peakInFlight()).toBe(1);
    q.dispose();
  });

  it('drops a failed batch without retrying or duplicating it', async () => {
    const c = controllableSend();
    const q = createWriteQueue(c.send);

    q.enqueue('x');
    c.rejectAt(0, new Error('blip'));
    await pump();
    expect(c.batches).toEqual(['x']);

    q.enqueue('y');
    await pump();
    expect(c.batches).toEqual(['x', 'y']);

    q.dispose();
  });

  it('ignores empty enqueues and enqueues after dispose', async () => {
    const c = controllableSend();
    const q = createWriteQueue(c.send);

    q.enqueue('');
    await pump();
    expect(c.batches).toEqual([]);

    q.dispose();
    q.enqueue('z');
    await pump();
    expect(c.batches).toEqual([]);
  });
});
