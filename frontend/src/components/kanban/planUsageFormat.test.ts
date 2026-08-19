import { describe, expect, it } from 'vitest';
import type { PlanUsageWindow } from 'shared/types';
import {
  clampPercent,
  describeReset,
  describeWindowLabel,
  formatPlanType,
} from './planUsageFormat';

function window(partial: Partial<PlanUsageWindow>): PlanUsageWindow {
  return {
    id: 'primary',
    usedPercent: null,
    windowMinutes: null,
    resetsAtMs: null,
    ...partial,
  };
}

describe('clampPercent', () => {
  it('rounds and clamps into 0..100', () => {
    expect(clampPercent(42.4)).toBe(42);
    expect(clampPercent(-3)).toBe(0);
    expect(clampPercent(140)).toBe(100);
  });

  it('returns null for missing or NaN values', () => {
    expect(clampPercent(null)).toBeNull();
    expect(clampPercent(undefined)).toBeNull();
    expect(clampPercent(Number.NaN)).toBeNull();
  });
});

describe('describeReset', () => {
  const now = 1_751_900_000_000;

  it('returns null without a reset timestamp', () => {
    expect(describeReset(null, now)).toBeNull();
    expect(describeReset(undefined, now)).toBeNull();
  });

  it('reports soon for past timestamps', () => {
    expect(describeReset(now - 1, now)).toEqual({ kind: 'soon' });
  });

  it('scales minutes to hours to days', () => {
    expect(describeReset(now + 30 * 60_000, now)).toEqual({
      kind: 'minutes',
      count: 30,
    });
    expect(describeReset(now + 3 * 3_600_000, now)).toEqual({
      kind: 'hours',
      count: 3,
    });
    expect(describeReset(now + 49 * 3_600_000, now)).toEqual({
      kind: 'days',
      count: 3,
    });
  });
});

describe('describeWindowLabel', () => {
  it('maps known claude window ids', () => {
    expect(describeWindowLabel(window({ id: 'five_hour' }))).toEqual({
      key: 'windowFiveHour',
    });
    expect(describeWindowLabel(window({ id: 'seven_day_opus' }))).toEqual({
      key: 'windowSevenDayOpus',
    });
    expect(describeWindowLabel(window({ id: 'extra_usage' }))).toEqual({
      key: 'windowExtraUsage',
    });
  });

  it('maps grok and cursor window ids', () => {
    expect(describeWindowLabel(window({ id: 'monthly' }))).toEqual({
      key: 'windowMonthly',
    });
    expect(describeWindowLabel(window({ id: 'cursor_models' }))).toEqual({
      key: 'windowCursorModels',
    });
    expect(describeWindowLabel(window({ id: 'other_models' }))).toEqual({
      key: 'windowOtherModels',
    });
  });

  it('derives duration labels for codex windows from minutes', () => {
    expect(
      describeWindowLabel(window({ id: 'primary', windowMinutes: 300 }))
    ).toEqual({ key: 'windowHours', count: 5 });
    expect(
      describeWindowLabel(window({ id: 'secondary', windowMinutes: 10_080 }))
    ).toEqual({ key: 'windowDays', count: 7 });
  });

  it('falls back to positional labels without minutes', () => {
    expect(describeWindowLabel(window({ id: 'primary' }))).toEqual({
      key: 'windowPrimary',
    });
    expect(describeWindowLabel(window({ id: 'secondary' }))).toEqual({
      key: 'windowSecondary',
    });
  });
});

describe('formatPlanType', () => {
  it('capitalizes known plan ids', () => {
    expect(formatPlanType('pro')).toBe('Pro');
    expect(formatPlanType('max')).toBe('Max');
  });

  it('passes through unknown values and hides empty ones', () => {
    expect(formatPlanType('scale-tier')).toBe('scale-tier');
    expect(formatPlanType(null)).toBeNull();
    expect(formatPlanType('')).toBeNull();
  });
});
