import type {
  ExecutionProcess,
  ExecutionProcessStatus,
  ExecutorAction,
} from 'shared/types';

import i18n from '@/i18n';

export type ContextCompactStatusKind = 'running' | 'success' | 'failed';

/**
 * Localized user-visible label for a context-compaction status. Resolved at call
 * time so it reflects the current UI language; pass `lng` to force a specific
 * language (used when matching historical entries produced in another language).
 */
function contextCompactStatusLabel(
  kind: ContextCompactStatusKind,
  lng?: string
): string {
  const options = lng ? { lng } : undefined;
  switch (kind) {
    case 'running':
      return i18n.t('app:contextCompact.running', options);
    case 'success':
      return i18n.t('app:contextCompact.success', options);
    case 'failed':
      return i18n.t('app:contextCompact.failed', options);
  }
}

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
  return (
    typeof prompt === 'string' && /^\/compact(?:\s|$)/i.test(prompt.trim())
  );
}

export function isContextCompactProcess(
  process:
    | Pick<ExecutionProcess, 'executor_action'>
    | { executor_action: ExecutorActionWithPrompt }
    | null
    | undefined
): boolean {
  return isContextCompactPrompt(
    getExecutorActionPrompt(process?.executor_action)
  );
}

export function getContextCompactStatusText(
  status: ExecutionProcessStatus | undefined
): string {
  if (status === 'failed' || status === 'killed') {
    return contextCompactStatusLabel('failed');
  }

  if (status === 'running') {
    return contextCompactStatusLabel('running');
  }

  return contextCompactStatusLabel('success');
}

export function getContextCompactStatusKind(
  content: string | null | undefined
): ContextCompactStatusKind | null {
  const trimmed = content?.trim();
  if (!trimmed) {
    return null;
  }

  // Match against every supported language so entries produced under a different
  // UI language are still recognized after the user switches languages.
  const kinds: ContextCompactStatusKind[] = ['running', 'success', 'failed'];
  for (const kind of kinds) {
    if (
      trimmed === contextCompactStatusLabel(kind, 'zh-CN') ||
      trimmed === contextCompactStatusLabel(kind, 'en')
    ) {
      return kind;
    }
  }

  return null;
}
