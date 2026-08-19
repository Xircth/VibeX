import { describe, expect, it } from 'vitest';

import type { LogRecord } from '@/lib/api';
import { applyLogBatch } from './logBuffer';

function rec(seq: number, message = 'm'): LogRecord {
  return {
    seq,
    timestamp_ms: 0,
    level: 'INFO',
    target: 't',
    message,
  };
}

describe('applyLogBatch', () => {
  it('appends new seqs and drops duplicates', () => {
    const next = applyLogBatch([rec(1), rec(2)], [rec(2), rec(3)], 10);
    expect(next.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('trims to the newest limit', () => {
    const next = applyLogBatch([rec(1), rec(2)], [rec(3), rec(4)], 3);
    expect(next.map((r) => r.seq)).toEqual([2, 3, 4]);
  });

  it('returns the same reference when nothing is new', () => {
    const prev = [rec(1)];
    expect(applyLogBatch(prev, [rec(1)], 10)).toBe(prev);
  });
});
