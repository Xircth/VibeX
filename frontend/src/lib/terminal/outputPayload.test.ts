import { describe, expect, it } from 'vitest';
import { parseTerminalOutputPayload } from './outputPayload';

describe('parseTerminalOutputPayload', () => {
  it('treats a legacy base64 string as seq 0 so output is never dropped', () => {
    expect(parseTerminalOutputPayload('aGVsbG8=')).toEqual({
      data: 'aGVsbG8=',
      seq: 0,
    });
  });

  it('reads the snapshot cursor from a structured event', () => {
    expect(parseTerminalOutputPayload({ data: 'aGVsbG8=', seq: 4 })).toEqual({
      data: 'aGVsbG8=',
      seq: 4,
    });
  });

  it('rejects payloads that cannot be written into xterm', () => {
    expect(parseTerminalOutputPayload(null)).toBeNull();
    expect(parseTerminalOutputPayload({ seq: 1 })).toBeNull();
  });
});
