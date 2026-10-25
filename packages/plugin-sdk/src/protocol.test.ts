import { describe, expect, it } from 'vitest';

import {
  FrameReassembler,
  ProtocolFrameError,
  encodeProtocolMessage,
  isSupportedPluginApiVersion,
} from './protocol.js';

describe('plugin protocol', () => {
  it('accepts worker apiVersion 1.0 and 2.0', () => {
    expect(isSupportedPluginApiVersion('1.0')).toBe(true);
    expect(isSupportedPluginApiVersion('2.0')).toBe(true);
    expect(isSupportedPluginApiVersion('3.0')).toBe(false);
  });

  it('discards an in-progress stream when a non-chunk message interrupts it', () => {
    const limits = { maxFrameBytes: 180, maxLogicalBytes: 64 * 1024 };
    const frames = new FrameReassembler(limits);
    const chunks = encodeProtocolMessage(
      {
        id: 'big',
        method: 'invoke',
        params: { handler: 'echo', input: 'x'.repeat(400) },
      },
      limits,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(frames.pushLine(chunks[0]!).kind).toBe('skip');
    expect(() =>
      frames.pushLine(JSON.stringify({ id: 'other', method: 'ping', params: {} })),
    ).toThrowError(ProtocolFrameError);

    const ping = frames.pushLine(
      JSON.stringify({ id: 'ok', method: 'ping', params: {} }),
    );
    expect(ping).toEqual({
      kind: 'message',
      message: { id: 'ok', method: 'ping', params: {} },
    });
  });

  it('releases the previous stream when a new stream starts at index 0', () => {
    const limits = { maxFrameBytes: 180, maxLogicalBytes: 64 * 1024 };
    const frames = new FrameReassembler(limits);
    const first = encodeProtocolMessage(
      {
        id: 'stream-a',
        method: 'invoke',
        params: { handler: 'echo', input: 'a'.repeat(400) },
      },
      limits,
    );
    const second = encodeProtocolMessage(
      {
        id: 'stream-b',
        method: 'invoke',
        params: { handler: 'echo', input: 'b'.repeat(400) },
      },
      limits,
    );
    expect(frames.pushLine(first[0]!).kind).toBe('skip');
    expect(() => frames.pushLine(second[0]!)).toThrowError(ProtocolFrameError);

    let decoded: ReturnType<FrameReassembler['pushLine']> | undefined;
    for (const chunk of second) {
      decoded = frames.pushLine(chunk);
    }
    expect(decoded).toMatchObject({
      kind: 'message',
      message: { id: 'stream-b' },
    });
  });

  it('clears accumulated parts when a stream exceeds maxLogicalBytes', () => {
    const frames = new FrameReassembler({
      maxFrameBytes: 180,
      maxLogicalBytes: 40,
    });
    const oversized = encodeProtocolMessage(
      {
        id: 'huge',
        method: 'invoke',
        params: { handler: 'echo', input: 'z'.repeat(400) },
      },
      { maxFrameBytes: 180, maxLogicalBytes: 10_000 },
    );
    expect(oversized.length).toBeGreaterThan(1);
    let overflowed = false;
    try {
      for (const chunk of oversized) {
        frames.pushLine(chunk);
      }
    } catch (error) {
      overflowed = error instanceof ProtocolFrameError;
    }
    expect(overflowed).toBe(true);

    const ping = frames.pushLine(
      JSON.stringify({ id: 'after', method: 'ping', params: {} }),
    );
    expect(ping).toMatchObject({
      kind: 'message',
      message: { id: 'after' },
    });
  });
});
