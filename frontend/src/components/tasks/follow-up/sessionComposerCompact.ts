import type {
  ExecutorProfileId,
  ProviderRuntimeEvent,
} from 'shared/types';
import { isContextCompactPrompt } from '@/lib/contextCompact';

export const CONTEXT_COMPACT_PROMPT = '/compact';

type CompactProcessCandidate = {
  id: string;
  status: string;
  executor_action?: {
    typ?: unknown;
  } | null;
};

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

export function getProviderRuntimeExecutionProcessId(
  event: Pick<ProviderRuntimeEvent, 'event'>
): string | null {
  if (!event.event || typeof event.event !== 'object') return null;

  const value = (event.event as Record<string, unknown>).execution_process_id;
  return typeof value === 'string' && value.trim() ? value : null;
}

export function shouldClearPendingCompactProcess(
  pendingProcessId: string | null,
  processes: Array<{ id: string }>
): boolean {
  return Boolean(
    pendingProcessId &&
      processes.some((process) => process.id === pendingProcessId)
  );
}

export function hasRunningContextCompactProcess(
  processes: CompactProcessCandidate[]
): boolean {
  return processes.some(
    (process) => process.status === 'running' && isContextCompactPrompt(
      process.executor_action?.typ &&
        typeof process.executor_action.typ === 'object' &&
        'prompt' in process.executor_action.typ &&
        typeof process.executor_action.typ.prompt === 'string'
        ? process.executor_action.typ.prompt
        : null
    )
  );
}

export function getIsCompactingContext({
  pendingCompactProcessId,
  isCompactProcessRunning,
}: {
  pendingCompactProcessId: string | null;
  isCompactProcessRunning: boolean;
}): boolean {
  return pendingCompactProcessId !== null || isCompactProcessRunning;
}

export function getCompactContextErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '未知错误';
  return `启动上下文压缩失败：${message}`;
}
