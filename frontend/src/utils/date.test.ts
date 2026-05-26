import { describe, expect, it } from 'vitest';

import { dateTimestamp } from './date';

describe('dateTimestamp', () => {
  it('converts ISO strings to millisecond timestamps', () => {
    expect(dateTimestamp('2026-05-26T01:02:03.000Z')).toBe(
      Date.UTC(2026, 4, 26, 1, 2, 3)
    );
  });

  it('converts Date objects to the same timestamp', () => {
    const date = new Date('2026-05-26T01:02:03.000Z');

    expect(dateTimestamp(date)).toBe(date.getTime());
  });

  it('converts numeric timestamps to the same millisecond value', () => {
    expect(dateTimestamp(1234)).toBe(1234);
  });

  it('preserves invalid Date behavior', () => {
    expect(Number.isNaN(dateTimestamp('not-a-date'))).toBe(true);
  });
});
