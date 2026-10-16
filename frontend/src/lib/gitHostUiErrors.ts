import i18n from '@/i18n';

export interface GitHostErrorPresentation {
  title: string;
  hint?: string;
  requiresGhSetup?: boolean;
}

export function normalizeGitHostErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error.trim();
  }
  if (error instanceof Error) {
    return error.message.trim();
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message.trim();
  }
  return '';
}

export function isGitHubCliSetupError(error: unknown): boolean {
  const lowered = normalizeGitHostErrorMessage(error).toLowerCase();
  if (!lowered) return false;
  return (
    lowered.includes('github cli') ||
    lowered.includes('`gh`') ||
    lowered.includes("'gh'") ||
    lowered.includes('gh auth') ||
    lowered.includes('executable not found') ||
    lowered.includes('not runnable') ||
    lowered.includes('authentication failed') ||
    lowered.includes('must authenticate') ||
    lowered.includes('not authenticated') ||
    lowered.includes('not logged into') ||
    lowered.includes('bad credentials') ||
    lowered.includes('unauthorized')
  );
}

export function getGitHostErrorPresentation(
  error: unknown,
  subject: 'Issues' | 'PRs'
): GitHostErrorPresentation | null {
  const message = normalizeGitHostErrorMessage(error);
  if (!message) {
    return null;
  }

  const lowered = message.toLowerCase();

  if (isGitHubCliSetupError(message)) {
    return {
      title: i18n.t('app:gitHostErrors.ghSetupRequired.title', {
        subject,
        defaultValue: `暂无法加载 ${subject}：需要安装并登录 GitHub CLI (gh)`,
      }),
      hint: i18n.t('app:gitHostErrors.ghSetupRequired.hint', {
        defaultValue:
          '请检查或安装 GitHub CLI (gh)，并完成 GitHub 账号登录后即可查看。',
      }),
      requiresGhSetup: true,
    };
  }

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
