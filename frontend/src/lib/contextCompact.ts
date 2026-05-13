import type {
  ExecutionProcess,
  ExecutionProcessStatus,
  ExecutorAction,
} from 'shared/types';

export const CONTEXT_COMPACT_RUNNING_TEXT = '正在执行上下文压缩...';
export const CONTEXT_COMPACT_SUCCESS_TEXT = '上下文已压缩';
export const CONTEXT_COMPACT_FAILED_TEXT = '上下文压缩失败';

type ExecutorActionWithPrompt = Pick<ExecutorAction, 'typ'>;

export function getExecutorActionPrompt(
  action: ExecutorActionWithPrompt | null | undefined
): string | null {
  const prompt =
    action &&
    'prompt' in action.typ &&
    typeof action.typ.prompt === 'string' &&
    action.typ.prompt.trim().length > 0
      ? action.typ.prompt
      : null;

  return prompt;
}

export function isContextCompactPrompt(
  prompt: string | null | undefined
): boolean {
  return typeof prompt === 'string' && /^\/compact(?:\s|$)/i.test(prompt.trim());
}

export function isContextCompactProcess(
  process:
    | Pick<ExecutionProcess, 'executor_action'>
    | { executor_action: ExecutorActionWithPrompt }
    | null
    | undefined
): boolean {
  return isContextCompactPrompt(getExecutorActionPrompt(process?.executor_action));
}

export function getContextCompactStatusText(
  status: ExecutionProcessStatus | undefined
): string {
  if (status === 'failed' || status === 'killed') {
    return CONTEXT_COMPACT_FAILED_TEXT;
  }

  if (status === 'running') {
    return CONTEXT_COMPACT_RUNNING_TEXT;
  }

  return CONTEXT_COMPACT_SUCCESS_TEXT;
}

export type ContextCompactStatusKind = 'running' | 'success' | 'failed';

export function getContextCompactStatusKind(
  content: string | null | undefined
): ContextCompactStatusKind | null {
  switch (content?.trim()) {
    case CONTEXT_COMPACT_RUNNING_TEXT:
      return 'running';
    case CONTEXT_COMPACT_SUCCESS_TEXT:
      return 'success';
    case CONTEXT_COMPACT_FAILED_TEXT:
      return 'failed';
    default:
      return null;
  }
}
