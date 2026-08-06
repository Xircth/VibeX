import i18n from '@/i18n';

export function agentManagementErrorMessage(
  error: unknown,
  fallback: string
): string {
  const message = extractMessage(error);
  if (!message) return fallback;
  if (
    i18n.resolvedLanguage?.startsWith('en') &&
    /[\u3400-\u9fff]/u.test(message)
  ) {
    return fallback;
  }
  return message;
}

function extractMessage(error: unknown): string | null {
  if (typeof error === 'string') return error.trim() || null;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message.trim() || null;
  }
  return null;
}
