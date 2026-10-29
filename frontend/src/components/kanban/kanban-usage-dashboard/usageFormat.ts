import { isUnresolvedModelAlias } from './usageModel';

export function formatOptionalNumber(
  value: number | null | undefined,
  notProvided: string
): string {
  return value == null ? notProvided : formatNumber(value);
}

export function formatOptionalCost(
  value: number | null | undefined,
  notProvided: string
): string {
  return value == null ? notProvided : formatCost(value);
}

export function displayUsageLabel(
  value: string | null | undefined,
  notProvided: string
): string {
  if (
    value == null ||
    value === '' ||
    value === 'unprovided' ||
    isUnresolvedModelAlias(value)
  ) {
    return notProvided;
  }
  return value;
}

export function extractFolderBasename(
  folderPath: string | null | undefined,
  fallback: string
): string {
  if (!folderPath) return fallback;
  const trimmed = folderPath.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || fallback;
}

export function formatNumber(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  if (safe >= 1_000_000_000) return `${(safe / 1_000_000_000).toFixed(1)}B`;
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(1)}K`;
  return Math.max(0, Math.round(safe)).toString();
}

export function formatCost(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `$${safe.toFixed(4)}`;
}

export function formatShortDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

export function formatTrendTooltipDate(
  dateStr: string,
  weekdayLabels: string[],
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekdayIdx = (date.getDay() + 6) % 7;
  const weekday = weekdayLabels[weekdayIdx] ?? '';
  return t('settings:kanbanUi.trendTooltipDate', { month, day, weekday });
}
