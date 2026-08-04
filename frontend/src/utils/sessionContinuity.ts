import i18n from '@/i18n';
import type { AgentKind, SessionContinuityMode } from 'shared/types';

export function getExecutorContinuityMode(
  _executor?: AgentKind | string | null
): SessionContinuityMode {
  // Reset-to-here is a destructive truncate-and-resend on the same conversation
  // — never a fork. Every executor resumes in place.
  return 'resume_in_place';
}

export function getContinuityActionCopy(mode: SessionContinuityMode) {
  switch (mode) {
    case 'resume_in_place':
      return {
        shortLabel: i18n.t('app:sessionContinuity.resumeInPlace.shortLabel'),
        retryLabel: i18n.t('app:sessionContinuity.resumeInPlace.retryLabel'),
        retryDescription: i18n.t(
          'app:sessionContinuity.resumeInPlace.retryDescription'
        ),
      };
    case 'new_session':
    default:
      return {
        shortLabel: i18n.t('app:sessionContinuity.newSession.shortLabel'),
        retryLabel: i18n.t('app:sessionContinuity.newSession.retryLabel'),
        retryDescription: i18n.t(
          'app:sessionContinuity.newSession.retryDescription'
        ),
      };
  }
}
