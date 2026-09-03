const INSTALL_FAILURE_MARKERS = [
  'Repair or reinstall it in Settings',
  'no current Installation lock',
  'not ready: NeedsRepair',
];

export function invokeErrorText(error: unknown): string {
  let message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : error &&
            typeof error === 'object' &&
            'message' in error &&
            typeof error.message === 'string'
          ? error.message
          : String(error);
  message = message.trim();
  message = message.replace(/^(Error:\s*)+/u, '');
  message = message.replace(
    /^(Bad request|Not found|Internal error|Conflict):\s*/iu,
    ''
  );
  return message.trim();
}

export function isAgentInstallLaunchError(message: string): boolean {
  return INSTALL_FAILURE_MARKERS.some((marker) => message.includes(marker));
}

export function splitLaunchError(message: string): {
  headline: string;
  detail: string | null;
} {
  const normalized = message.replace(/\r\n/g, '\n').trim();
  const blank = normalized.indexOf('\n\n');
  if (blank === -1) {
    return { headline: normalized, detail: null };
  }
  const headline = normalized.slice(0, blank).trim();
  const detail = normalized.slice(blank + 2).trim();
  return { headline, detail: detail || null };
}
