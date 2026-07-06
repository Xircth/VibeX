import i18n from '@/i18n';

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return '';
  }
}

export function getSessionUiErrorMessage(
  error: unknown,
  fallback: string
): string {
  const message = extractErrorMessage(error);
  const lowered = message.toLowerCase();

  if (!message) {
    return fallback;
  }

  const cleanMessage = message.replace(
    /^(Bad request|Internal error|Not found|Conflict):\s*/i,
    ''
  );
  if (
    cleanMessage.startsWith('\u5f53\u524d\u5206\u652f') &&
    cleanMessage.includes('\u672a\u63d0\u4ea4\u66f4\u6539')
  ) {
    return cleanMessage;
  }
  if (
    lowered.includes('local changes') &&
    lowered.includes('would be overwritten by checkout')
  ) {
    return i18n.t('app:sessionErrors.uncommittedChangesCannotSwitch');
  }

  if (message.includes('Workspace is required'))
    return i18n.t('app:sessionErrors.workspaceRequired');
  if (
    message.includes('会话仍在执行') ||
    message.includes('Process already running')
  ) {
    return i18n.t('app:sessionErrors.sessionStillRunning');
  }
  if (message.includes('Session') && message.includes('not found')) {
    return i18n.t('app:sessionErrors.sessionNotFound');
  }
  if (message.includes('Workspace') && message.includes('not found')) {
    return i18n.t('app:sessionErrors.workspaceNotFound');
  }
  if (message.includes('Executor mismatch')) {
    return i18n.t('app:sessionErrors.executorMismatch');
  }
  if (lowered.includes('invalid reference')) {
    return i18n.t('app:sessionErrors.invalidReference');
  }

  return message || fallback;
}
