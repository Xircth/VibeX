import type { BaseCodingAgent, SessionContinuityMode } from 'shared/types';

export function getExecutorContinuityMode(
  executor?: BaseCodingAgent | string | null
): SessionContinuityMode {
  if (executor === 'CODEX' || executor === 'OPENCODE') {
    return 'fork_snapshot';
  }
  return 'resume_in_place';
}

export function getContinuityActionCopy(mode: SessionContinuityMode) {
  switch (mode) {
    case 'fork_snapshot':
      return {
        shortLabel: '快照分叉',
        retryLabel: '快照重试',
        retryDescription: '会从当前保留快照分叉出一条新会话继续执行。',
      };
    case 'resume_in_place':
      return {
        shortLabel: '原地续写',
        retryLabel: '原地重试',
        retryDescription: '会在当前会话上下文中回退后继续执行。',
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
