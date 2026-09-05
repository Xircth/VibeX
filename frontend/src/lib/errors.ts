function getErrorField(error: unknown, key: 'message' | 'name'): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    key in error &&
    typeof (error as Record<string, unknown>)[key] === 'string'
  ) {
    return (error as Record<string, string>)[key];
  }
  return '';
}

export function getInvokeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  const message = getErrorField(error, 'message');
  if (message) {
    return message;
  }
  try {
    return JSON.stringify(error) || 'Unknown error';
  } catch {
    return 'Unknown error';
  }
}

export function isCanceledError(error: unknown): boolean {
  const message = getInvokeErrorMessage(error);
  const name =
    error instanceof Error ? error.name : getErrorField(error, 'name');
  const normalized = `${name} ${message}`.toLowerCase();
  return normalized.includes('canceled') || normalized.includes('cancelled');
}
