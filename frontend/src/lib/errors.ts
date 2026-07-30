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

export function isCanceledError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : getErrorField(error, 'message');
  const name =
    error instanceof Error ? error.name : getErrorField(error, 'name');
  const normalized = `${name} ${message}`.toLowerCase();
  return normalized.includes('canceled') || normalized.includes('cancelled');
}
