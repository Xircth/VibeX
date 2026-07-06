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
        shortLabel: '回到此处',
        retryLabel: '回到此处重试',
        retryDescription: '会回退到此处并删除其后的消息，然后重新执行。',
      };
    case 'new_session':
    default:
      return {
        shortLabel: '全新上下文',
        retryLabel: '新会话重试',
        retryDescription: '会创建一条新的执行上下文重新开始。',
      };
  }
}
