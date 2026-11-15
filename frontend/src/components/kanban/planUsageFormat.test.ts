import { describe, expect, it } from 'vitest';
import type { PlanUsageWindow } from 'shared/types';
import {
  buildPlanQuotaRows,
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
    expect(describeWindowLabel(window({ id: 'weekly' }))).toEqual({
      key: 'windowWeekly',
    });
    expect(describeWindowLabel(window({ id: 'monthly' }))).toEqual({
      key: 'windowMonthly',
    });
    expect(describeWindowLabel(window({ id: 'rolling' }))).toEqual({
      key: 'windowRolling',
    });
    expect(describeWindowLabel(window({ id: 'cursor_models' }))).toEqual({
      key: 'windowCursorModels',
    });
    expect(describeWindowLabel(window({ id: 'other_models' }))).toEqual({
      key: 'windowOtherModels',
    });
    expect(describeWindowLabel(window({ id: 'gemini_five_hour' }))).toEqual({
      key: 'windowGeminiFiveHour',
    });
    expect(describeWindowLabel(window({ id: 'claude_gpt_weekly' }))).toEqual({
      key: 'windowClaudeGptWeekly',
    });
    expect(describeWindowLabel(window({ id: 'argon_five_hour' }))).toEqual({
      key: 'windowArgonFiveHour',
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

describe('buildPlanQuotaRows', () => {
  it('returns empty rows when usage is missing or has no active windows or credits', () => {
    expect(buildPlanQuotaRows(undefined)).toEqual([]);
    expect(
      buildPlanQuotaRows({ planType: 'pro', windows: [], credits: null })
    ).toEqual([]);
    expect(
      buildPlanQuotaRows({
        planType: 'pro',
        windows: [],
        credits: { balance: null, unlimited: false },
      })
    ).toEqual([]);
  });

  it('groups windows into rows of at most 2 items', () => {
    const fourWindows = [
      window({ id: 'gemini_five_hour', usedPercent: 20 }),
      window({ id: 'gemini_weekly', usedPercent: 10 }),
      window({ id: 'claude_gpt_five_hour', usedPercent: 45 }),
      window({ id: 'claude_gpt_weekly', usedPercent: 30 }),
    ];
    const rows = buildPlanQuotaRows({
      planType: 'pro',
      windows: fourWindows,
      credits: null,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].map((item) => item.id)).toEqual([
      'gemini_five_hour',
      'gemini_weekly',
    ]);
    expect(rows[1].map((item) => item.id)).toEqual([
      'claude_gpt_five_hour',
      'claude_gpt_weekly',
    ]);
  });

  it('falls back to a single credits item when no windows are returned', () => {
    const rows = buildPlanQuotaRows({
      planType: null,
      windows: [],
      credits: { balance: '15.00', unlimited: false },
    });
    expect(rows).toEqual([
      [
        {
          kind: 'credits',
          id: 'credits',
          credits: { balance: '15.00', unlimited: false },
        },
      ],
    ]);
  });
});
