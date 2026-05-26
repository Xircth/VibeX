import { describe, expect, it } from 'vitest';
import {
  BaseCodingAgent,
  ExecutionProcessStatus,
  type NormalizedEntry,
} from 'shared/types';
import { CONTEXT_COMPACT_RUNNING_TEXT } from '@/lib/contextCompact';
import { getConversationCodingAgentDisplay } from './conversationCodingAgentDisplay';
import type { ExecutionProcessState, PatchTypeWithKey } from './types';

function codingProcessState(
  entries: PatchTypeWithKey[],
  prompt = 'build the feature'
): ExecutionProcessState {
  return {
    executionProcess: {
      id: 'process-1',
      created_at: '2026-05-26T00:00:00.000Z',
      updated_at: '2026-05-26T00:00:00.000Z',
      executor_action: {
        typ: {
          type: 'CodingAgentInitialRequest',
          prompt,
          executor_profile_id: {
            executor: BaseCodingAgent.CODEX,
            variant: null,
          },
          working_dir: null,
        },
        next_action: null,
      },
    },
    entries,
  };
}

function scriptProcessState(): ExecutionProcessState {
  return {
    executionProcess: {
      id: 'script-1',
      created_at: '2026-05-26T00:00:00.000Z',
      updated_at: '2026-05-26T00:00:00.000Z',
      executor_action: {
        typ: {
          type: 'ScriptRequest',
          script: 'echo setup',
          language: 'Bash',
          context: 'SetupScript',
          working_dir: null,
        },
        next_action: null,
      },
    },
    entries: [],
  };
}

function normalizedEntry(
  patchKey: string,
  content: NormalizedEntry
): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    content,
    patchKey,
    executionProcessId: 'process-1',
  };
}

function userEntry(content = 'raw user prompt'): PatchTypeWithKey {
  return normalizedEntry('process-1:raw-user', {
    entry_type: { type: 'user_message' },
    content,
    timestamp: null,
  });
}

function assistantEntry(content: string): PatchTypeWithKey {
  return normalizedEntry(`process-1:assistant:${content.length}`, {
    entry_type: { type: 'assistant_message' },
    content,
    timestamp: null,
  });
}

function tokenUsageEntry(): PatchTypeWithKey {
  return normalizedEntry('process-1:token', {
    entry_type: {
      type: 'token_usage_info',
      total_tokens: 3,
      model_context_window: 100,
    },
    content: '',
    timestamp: null,
  });
}

function pendingApprovalEntry(): PatchTypeWithKey {
  return normalizedEntry('process-1:approval', {
    entry_type: {
      type: 'tool_use',
      tool_name: 'Edit',
      action_type: {
        action: 'command_run',
        command: 'edit',
        result: {
          output: null,
          exit_status: null,
        },
      },
      status: {
        status: 'pending_approval',
        approval_id: 'approval-1',
        requested_at: '2026-05-26T00:00:00.000Z',
        timeout_at: '2026-05-26T00:01:00.000Z',
      },
    },
    content: 'Edit',
    timestamp: null,
  });
}

function setupRequiredEntry(): PatchTypeWithKey {
  return normalizedEntry('process-1:setup-required', {
    entry_type: {
      type: 'error_message',
      error_type: {
        type: 'setup_required',
      },
    },
    content: 'Run setup first',
    timestamp: null,
  });
}

describe('conversationCodingAgentDisplay', () => {
  it('returns null for non-agent processes', () => {
    expect(
      getConversationCodingAgentDisplay(scriptProcessState(), {
        previousAssistantTranscript: '',
      })
    ).toBeNull();
  });

  it('adds the synthetic user prompt and filters raw user and token entries', () => {
    const display = getConversationCodingAgentDisplay(
      codingProcessState([
        userEntry(),
        tokenUsageEntry(),
        assistantEntry('done'),
      ]),
      {
        previousAssistantTranscript: '',
      }
    );

    expect(display?.entries).toHaveLength(2);
    expect(display?.entries[0]).toMatchObject({
      patchKey: 'process-1:user',
      content: {
        entry_type: { type: 'user_message' },
        content: 'build the feature',
      },
    });
    expect(display?.entries[1]).toMatchObject({
      patchKey: 'process-1:assistant:4',
      content: {
        entry_type: { type: 'assistant_message' },
        content: 'done',
      },
    });
    expect(display?.nextAssistantTranscript).toBe('done');
  });

  it('strips already displayed assistant transcript prefixes', () => {
    const firstReply = 'first reply with enough context';
    const display = getConversationCodingAgentDisplay(
      codingProcessState([assistantEntry(`${firstReply}\n\nsecond reply`)]),
      {
        previousAssistantTranscript: firstReply,
      }
    );

    expect(display?.entries[1]).toMatchObject({
      content: {
        entry_type: { type: 'assistant_message' },
        content: 'second reply',
      },
    });
    expect(display?.nextAssistantTranscript).toBe(`${firstReply}second reply`);
  });

  it('suppresses loading while a running process waits on approval', () => {
    const display = getConversationCodingAgentDisplay(
      codingProcessState([pendingApprovalEntry()]),
      {
        previousAssistantTranscript: '',
        liveProcessStatus: ExecutionProcessStatus.running,
      }
    );

    expect(display?.hasPendingApproval).toBe(true);
    expect(display?.isRunning).toBe(true);
    expect(display?.entries.map((entry) => entry.patchKey)).not.toContain(
      'process-1:loading'
    );
  });

  it('adds loading while a process is running without pending approval', () => {
    const display = getConversationCodingAgentDisplay(
      codingProcessState([assistantEntry('working')]),
      {
        previousAssistantTranscript: '',
        liveProcessStatus: ExecutionProcessStatus.running,
      }
    );

    expect(display?.isRunning).toBe(true);
    expect(display?.entries.at(-1)).toMatchObject({
      patchKey: 'process-1:loading',
      content: {
        entry_type: { type: 'loading' },
      },
    });
  });

  it('reports setup-required help text for failed agent processes', () => {
    const display = getConversationCodingAgentDisplay(
      codingProcessState([setupRequiredEntry()]),
      {
        previousAssistantTranscript: '',
        liveProcessStatus: ExecutionProcessStatus.failed,
      }
    );

    expect(display?.isFailedOrKilled).toBe(true);
    expect(display?.setupHelpText).toBe('Run setup first');
  });

  it('delegates context compact prompts to the compact display helper', () => {
    const display = getConversationCodingAgentDisplay(
      codingProcessState([], '/compact'),
      {
        previousAssistantTranscript: 'existing',
        liveProcessStatus: ExecutionProcessStatus.running,
      }
    );

    expect(display?.entries).toHaveLength(1);
    expect(display?.entries[0]).toMatchObject({
      patchKey: 'process-1:context-compact',
      content: {
        entry_type: { type: 'system_message' },
        content: CONTEXT_COMPACT_RUNNING_TEXT,
      },
    });
    expect(display?.isRunning).toBe(true);
    expect(display?.nextAssistantTranscript).toBe('existing');
  });
});
