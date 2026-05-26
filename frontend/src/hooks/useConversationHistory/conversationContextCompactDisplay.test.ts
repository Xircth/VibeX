import {
  CONTEXT_COMPACT_FAILED_TEXT,
  CONTEXT_COMPACT_RUNNING_TEXT,
  CONTEXT_COMPACT_SUCCESS_TEXT,
} from '@/lib/contextCompact';
import { BaseCodingAgent, ExecutionProcessStatus } from 'shared/types';
import { describe, expect, it } from 'vitest';
import { getConversationContextCompactDisplay } from './conversationContextCompactDisplay';
import type { ExecutionProcessState } from './types';
import type { ExecutorActionType, NormalizedEntry } from 'shared/types';

function codingAction(prompt: string): ExecutorActionType {
  return {
    type: 'CodingAgentFollowUpRequest',
    prompt,
    session_id: 'session-compact',
    reset_to_message_id: null,
    executor_profile_id: {
      executor: BaseCodingAgent.CODEX,
      variant: null,
    },
    working_dir: null,
  };
}

function processState(prompt: string): ExecutionProcessState {
  return {
    executionProcess: {
      id: 'process-compact',
      created_at: '2026-03-22T00:00:00.000Z',
      updated_at: '2026-03-22T00:00:00.000Z',
      executor_action: {
        typ: codingAction(prompt),
        next_action: null,
      },
    },
    entries: [],
  };
}

function normalizedContent(
  display: NonNullable<ReturnType<typeof getConversationContextCompactDisplay>>
): NormalizedEntry {
  const { content } = display.entry;
  if (typeof content === 'string' || !('entry_type' in content)) {
    throw new Error('Expected a normalized context compact entry');
  }
  return content;
}

describe('conversationContextCompactDisplay', () => {
  it('returns null for non-compact prompts', () => {
    expect(
      getConversationContextCompactDisplay(
        processState('regular follow-up'),
        ExecutionProcessStatus.completed
      )
    ).toBeNull();
  });

  it('renders running compact prompts as system status entries', () => {
    const display = getConversationContextCompactDisplay(
      processState('/compact'),
      ExecutionProcessStatus.running
    );

    expect(display?.isRunning).toBe(true);
    expect(display?.isFailedOrKilled).toBe(false);
    expect(display?.entry.patchKey).toBe('process-compact:context-compact');
    expect(normalizedContent(display!).entry_type).toEqual({
      type: 'system_message',
    });
    expect(normalizedContent(display!).content).toBe(
      CONTEXT_COMPACT_RUNNING_TEXT
    );
  });

  it('renders completed or missing compact status as success system entries', () => {
    const completedDisplay = getConversationContextCompactDisplay(
      processState('/compact now'),
      ExecutionProcessStatus.completed
    );
    const missingStatusDisplay = getConversationContextCompactDisplay(
      processState('/compact now'),
      undefined
    );

    expect(normalizedContent(completedDisplay!).entry_type).toEqual({
      type: 'system_message',
    });
    expect(normalizedContent(completedDisplay!).content).toBe(
      CONTEXT_COMPACT_SUCCESS_TEXT
    );
    expect(normalizedContent(missingStatusDisplay!).content).toBe(
      CONTEXT_COMPACT_SUCCESS_TEXT
    );
  });

  it.each([ExecutionProcessStatus.failed, ExecutionProcessStatus.killed])(
    'renders %s compact status as an error entry',
    (status) => {
      const display = getConversationContextCompactDisplay(
        processState('/compact'),
        status
      );

      expect(display?.isRunning).toBe(false);
      expect(display?.isFailedOrKilled).toBe(true);
      expect(normalizedContent(display!).entry_type).toEqual({
        type: 'error_message',
        error_type: {
          type: 'other',
        },
      });
      expect(normalizedContent(display!).content).toBe(
        CONTEXT_COMPACT_FAILED_TEXT
      );
    }
  );
});
