import { describe, expect, it } from 'vitest';
import { canSkipInFlightHistoryWait } from './canSkipInFlightHistoryWait';

describe('canSkipInFlightHistoryWait', () => {
  it('waits when capabilities are unknown', () => {
    expect(canSkipInFlightHistoryWait(undefined)).toBe(false);
    expect(canSkipInFlightHistoryWait(null)).toBe(false);
    expect(canSkipInFlightHistoryWait({})).toBe(false);
  });

  it('waits when the profile can resume or load', () => {
    expect(
      canSkipInFlightHistoryWait({
        resume_session: true,
        load_session: false,
      })
    ).toBe(false);
    expect(
      canSkipInFlightHistoryWait({
        resume_session: false,
        load_session: true,
      })
    ).toBe(false);
  });

  it('skips only when the profile declared neither resume nor load', () => {
    expect(
      canSkipInFlightHistoryWait({
        resume_session: false,
        load_session: false,
      })
    ).toBe(true);
  });
});
