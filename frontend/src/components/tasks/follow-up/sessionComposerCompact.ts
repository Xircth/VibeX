import type { ExecutorProfileId } from 'shared/types';

export const CONTEXT_COMPACT_PROMPT = '/compact';

export function buildCompactContextTurnInput({
  sessionId,
  workspaceId,
  executorProfile,
  canCompact,
}: {
  sessionId: string | null | undefined;
  workspaceId: string | null | undefined;
  executorProfile: ExecutorProfileId | null | undefined;
  canCompact: boolean;
}): {
  workspaceId: string;
  sessionId: string;
  executorProfileId: ExecutorProfileId;
  text: typeof CONTEXT_COMPACT_PROMPT;
} | null {
  if (!sessionId || !workspaceId || !executorProfile || !canCompact) {
    return null;
  }

  return {
    workspaceId,
    sessionId,
    executorProfileId: executorProfile,
    text: CONTEXT_COMPACT_PROMPT,
  };
}

export function getIsCompactingContext({
  pendingCompactProcessId,
}: {
  pendingCompactProcessId: string | null;
}): boolean {
  return pendingCompactProcessId !== null;
}

export function getCompactContextErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '未知错误';
  return `启动上下文压缩失败：${message}`;
}
