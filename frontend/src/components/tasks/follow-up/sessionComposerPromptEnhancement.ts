import type {
  PromptEnhancementContextMessage,
  PromptEnhancementRequest,
} from '@/lib/api/config';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;

  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown enhancement error';
  }
}

export function getPromptEnhancementStartDecision({
  isEnhancingPrompt,
  draftPrompt,
}: {
  isEnhancingPrompt: boolean;
  draftPrompt: string;
}): {
  shouldStartEnhancement: boolean;
} {
  return {
    shouldStartEnhancement: !isEnhancingPrompt && Boolean(draftPrompt.trim()),
  };
}

export function canEnhancePrompt({
  canTypeFollowUp,
  draftPrompt,
}: {
  canTypeFollowUp: boolean;
  draftPrompt: string;
}): boolean {
  return canTypeFollowUp && Boolean(draftPrompt.trim());
}

export function getPromptEnhancementErrorMessage(error: unknown): string {
  const rawMessage = getErrorMessage(error).trim();
  const detail = rawMessage
    .replace(/^(Bad request|Internal error|Not found):\s*/i, '')
    .trim();

  if (/Prompt enhancement is disabled in system settings/i.test(detail)) {
    return 'Prompt enhancement failed: disabled in system settings.';
  }
  if (/Draft prompt cannot be empty/i.test(detail)) {
    return 'Prompt enhancement failed: draft prompt cannot be empty.';
  }
  if (/Prompt enhancement returned empty content/i.test(detail)) {
    return 'Prompt enhancement failed: enhanced prompt was empty.';
  }
  if (/OpenCode CLI not found/i.test(detail)) {
    return 'Prompt enhancement failed: OpenCode is not available.';
  }
  if (
    /OpenCode response did not contain a valid EnhancedPrompt field/i.test(
      detail
    )
  ) {
    return 'Prompt enhancement failed: OpenCode returned no valid enhanced prompt.';
  }
  if (/OpenCode prompt enhancement failed/i.test(detail)) {
    return 'Prompt enhancement failed: OpenCode execution failed.';
  }
  if (/OpenCode prompt enhancement timed out/i.test(detail)) {
    return 'Prompt enhancement failed: OpenCode timed out.';
  }
  if (/Failed to run OpenCode/i.test(detail)) {
    return 'Prompt enhancement failed: failed to start OpenCode.';
  }

  const normalizedDetail = detail || rawMessage || 'Unknown error';
  return `Prompt enhancement failed: ${normalizedDetail}`;
}

export function buildPromptEnhancementRequest({
  draftPrompt,
  sessionId,
  workspaceId,
  contextMessages,
}: {
  draftPrompt: string;
  sessionId: string | null | undefined;
  workspaceId: string | null | undefined;
  contextMessages: PromptEnhancementContextMessage[];
}): PromptEnhancementRequest {
  return {
    draftPrompt,
    sessionId: sessionId ?? null,
    workspaceId: workspaceId ?? null,
    contextMessages,
  };
}

export function normalizeEnhancedPrompt({
  enhancedPrompt,
}: {
  enhancedPrompt: string;
}): string {
  const trimmed = enhancedPrompt.trim();
  if (!trimmed) {
    throw new Error('Prompt enhancement returned empty content');
  }
  return trimmed;
}
