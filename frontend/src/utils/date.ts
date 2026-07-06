import i18n from '@/i18n';

export function dateTimestamp(value: string | number | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * Format a date string as "Jan 5, 10:30 AM".
 */
export function formatDateShortWithTime(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Relative time in Chinese — the single source of truth for relative-time
 * display (Chinese baseline). Accepts an ISO string, ms timestamp, or Date.
 * e.g. "刚刚", "5 分钟前", "2 小时前", "3 天前", "4 个月前", "1 年前".
 */
export function formatRelativeTime(value: string | number | Date): string {
  const diffMs = Date.now() - dateTimestamp(value);
  const seconds = Math.max(Math.round(Math.abs(diffMs) / 1000), 1);
  const future = diffMs < 0;

  if (seconds < 60) return i18n.t('app:date.justNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60)
    return i18n.t(future ? 'app:date.minutesLater' : 'app:date.minutesAgo', { value: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24)
    return i18n.t(future ? 'app:date.hoursLater' : 'app:date.hoursAgo', { value: hours });
  const days = Math.round(hours / 24);
  if (days < 30)
    return i18n.t(future ? 'app:date.daysLater' : 'app:date.daysAgo', { value: days });
  const months = Math.round(days / 30);
  if (months < 12)
    return i18n.t(future ? 'app:date.monthsLater' : 'app:date.monthsAgo', { value: months });
  return i18n.t(future ? 'app:date.yearsLater' : 'app:date.yearsAgo', {
    value: Math.round(months / 12),
  });
}
