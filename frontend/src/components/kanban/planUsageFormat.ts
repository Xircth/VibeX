import type { PlanUsageWindow } from 'shared/types';

export function clampPercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

export type ResetDescriptor =
  | { kind: 'soon' }
  | { kind: 'minutes' | 'hours' | 'days'; count: number }
  | null;

export function describeReset(
  resetsAtMs: number | null | undefined,
  nowMs: number
): ResetDescriptor {
  if (typeof resetsAtMs !== 'number' || !Number.isFinite(resetsAtMs)) {
    return null;
  }

  const diffMs = resetsAtMs - nowMs;
  if (diffMs <= 0) return { kind: 'soon' };

  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return { kind: 'minutes', count: minutes };

  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return { kind: 'hours', count: hours };

  return { kind: 'days', count: Math.ceil(hours / 24) };
}

/** i18n key suffix (under usageDashboard.planUsage) + optional plural count. */
export type WindowLabelDescriptor = { key: string; count?: number };

export function describeWindowLabel(
  window: PlanUsageWindow
): WindowLabelDescriptor {
  switch (window.id) {
    case 'five_hour':
      return { key: 'windowFiveHour' };
    case 'seven_day':
      return { key: 'windowSevenDay' };
    case 'seven_day_opus':
      return { key: 'windowSevenDayOpus' };
    case 'seven_day_sonnet':
      return { key: 'windowSevenDaySonnet' };
    case 'extra_usage':
      return { key: 'windowExtraUsage' };
    default: {
      const minutes = window.windowMinutes;
      if (typeof minutes === 'number' && minutes > 0) {
        if (minutes % 1440 === 0) {
          return { key: 'windowDays', count: minutes / 1440 };
        }
        if (minutes % 60 === 0) {
          return { key: 'windowHours', count: minutes / 60 };
        }
      }
      return window.id === 'secondary'
        ? { key: 'windowSecondary' }
        : { key: 'windowPrimary' };
    }
  }
}

export function formatPlanType(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const known: Record<string, string> = {
    pro: 'Pro',
    plus: 'Plus',
    max: 'Max',
    team: 'Team',
    enterprise: 'Enterprise',
    free: 'Free',
  };
  return known[value.toLowerCase()] ?? value;
}
