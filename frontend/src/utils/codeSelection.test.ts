import { describe, expect, it } from 'vitest';
import { computeLineRange, formatFileRangeRef } from './codeSelection';

const CONTENT = `line one
line two
line three
line four`;

describe('computeLineRange', () => {
  it('maps a single-line selection', () => {
    expect(computeLineRange(CONTENT, 'line two')).toEqual({
      startLine: 2,
      endLine: 2,
    });
  });

  it('maps a multi-line selection', () => {
    expect(computeLineRange(CONTENT, 'line two\nline three')).toEqual({
      startLine: 2,
      endLine: 3,
    });
  });

  it('ignores trailing newlines in the selection', () => {
    expect(computeLineRange(CONTENT, 'line two\n')).toEqual({
      startLine: 2,
      endLine: 2,
    });
  });

  it('returns null for empty or missing fragments', () => {
    expect(computeLineRange(CONTENT, '   ')).toBeNull();
    expect(computeLineRange(CONTENT, 'not present')).toBeNull();
  });

  it('returns null when the fragment is ambiguous (repeats)', () => {
    // A boilerplate line that appears more than once (or old-side diff text
    // that also exists elsewhere in the file) can't be mapped to a single
    // occurrence from selection text alone — refuse rather than cite a wrong line.
    const dup = `open\n});\nmiddle\n});\nclose`;
    expect(computeLineRange(dup, '});')).toBeNull();
  });

  it('still maps a multi-line selection that is unique even if a sub-line repeats', () => {
    const dup = `head\n});\nbody\n});\ntail`;
    expect(computeLineRange(dup, '});\nbody')).toEqual({
      startLine: 2,
      endLine: 3,
    });
  });

  it('is robust to CRLF content', () => {
    expect(computeLineRange('a\r\nb\r\nc', 'b')).toEqual({
      startLine: 2,
      endLine: 2,
    });
  });
});

describe('formatFileRangeRef', () => {
  it('collapses a single line', () => {
    expect(formatFileRangeRef('src/a.ts', 5, 5)).toBe('src/a.ts:5');
  });
  it('formats a range', () => {
    expect(formatFileRangeRef('src/a.ts', 5, 9)).toBe('src/a.ts:5-9');
  });
});
