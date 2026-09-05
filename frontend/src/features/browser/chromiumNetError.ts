export interface BrowserLoadErrorInfo {
  code: string;
  message: string;
}

export function isCancelledBrowserError(
  code: string,
  message: string
): boolean {
  const text = `${code} ${message}`.toUpperCase();
  return (
    text.includes('ERR_ABORTED') || /(^|[^A-Z])ABORTED([^A-Z]|$)/.test(text)
  );
}

export function browserErrorCode(info: BrowserLoadErrorInfo): string {
  const fromCode = info.code.trim();
  if (/ERR_[A-Z0-9_]+/.test(fromCode))
    return fromCode.match(/ERR_[A-Z0-9_]+/)![0];
  const fromMessage = info.message.toUpperCase().match(/ERR_[A-Z0-9_]+/);
  return fromMessage?.[0] ?? fromCode;
}

export type BrowserLoadErrorKind =
  | 'notFound'
  | 'timedOut'
  | 'connection'
  | 'certificate'
  | 'generic';

export function browserLoadErrorKind(
  info: BrowserLoadErrorInfo
): BrowserLoadErrorKind {
  const text = `${info.code} ${info.message}`.toUpperCase();
  if (text.includes('NAME_NOT_RESOLVED') || text.includes('NAME_NOT_FOUND')) {
    return 'notFound';
  }
  if (text.includes('TIMED_OUT') || text.includes('TIMEOUT')) {
    return 'timedOut';
  }
  if (text.includes('CERT')) return 'certificate';
  if (
    text.includes('SOCKET') ||
    text.includes('CONNECTION') ||
    text.includes('CONNECT') ||
    text.includes('RESET') ||
    text.includes('REFUSED')
  ) {
    return 'connection';
  }
  return 'generic';
}
