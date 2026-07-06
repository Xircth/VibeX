import i18n from '@/i18n';

export interface GitHostErrorPresentation {
  title: string;
  hint?: string;
}

function normalizeErrorMessage(error: string | null | undefined): string {
  return (error ?? '').trim();
}

export function getGitHostErrorPresentation(
  error: string | null | undefined,
  subject: 'Issues' | 'PRs'
): GitHostErrorPresentation | null {
  const message = normalizeErrorMessage(error);
  if (!message) {
    return null;
  }

  const lowered = message.toLowerCase();

  if (lowered.includes('no remotes configured')) {
    return {
      title: i18n.t('app:gitHostErrors.noRemotes.title', { subject }),
      hint: i18n.t('app:gitHostErrors.noRemotes.hint'),
    };
  }

  if (lowered.includes('invalid repository')) {
    return {
      title: i18n.t('app:gitHostErrors.invalidRepository.title', { subject }),
      hint: i18n.t('app:gitHostErrors.invalidRepository.hint'),
    };
  }

  return {
    title: i18n.t('app:gitHostErrors.generic.title', { subject }),
    hint: message,
  };
}
