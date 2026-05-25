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
    return '\u5f53\u524d\u5206\u652f\u5b58\u5728\u672a\u63d0\u4ea4\u66f4\u6539\uff0c\u65e0\u6cd5\u5207\u6362\u5206\u652f\uff0c\u8bf7\u5148\u63d0\u4ea4\u6216\u653e\u5f03\u66f4\u6539\u3002';
  }

  if (message.includes('Workspace is required')) return '请选择工作区。';
  if (
    message.includes('会话仍在执行') ||
    message.includes('Process already running')
  ) {
    return '会话仍在执行，暂时无法删除。';
  }
  if (message.includes('Session') && message.includes('not found')) {
    return '会话不存在或已被删除。';
  }
  if (message.includes('Workspace') && message.includes('not found')) {
    return '工作区不存在。';
  }
  if (message.includes('Executor mismatch')) {
    return '当前会话绑定的代理与所选代理不一致。';
  }
  if (lowered.includes('invalid reference')) {
    return '所选分支不存在，工作区/分支列表可能已过期。请刷新后重新选择。';
  }

  return message || fallback;
}
