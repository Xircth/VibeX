import { describe, expect, it } from 'vitest';
import type { NormalizedEntry } from 'shared/types';
import type {
  AgentEventEnvelope,
  ImportedAgentMessage,
} from '@/features/agents/types';
import {
  adaptAgentEventEnvelope,
  adaptContentParts,
  adaptImportedAgentMessage,
  adaptNormalizedEntry,
} from './adaptContentParts';

function normalized(
  entry_type: NormalizedEntry['entry_type'],
  content = 'content'
): NormalizedEntry {
  return {
    timestamp: '2026-06-12T00:00:00.000Z',
    entry_type,
    content,
  };
}

function event(
  sequence: number,
  eventValue: AgentEventEnvelope['event']
): AgentEventEnvelope {
  return {
    sequence,
    workspace_id: 'workspace',
    connection_id: 'connection',
    session_id: 'session',
    created_at: `2026-06-12T00:00:0${sequence}.000Z`,
    event: eventValue,
  };
}

describe('adaptContentParts', () => {
  it.each([
    {
      name: 'assistant text',
      entry: normalized({ type: 'assistant_message' }, 'hello'),
      expectedType: 'text',
    },
    {
      name: 'reasoning',
      entry: normalized({ type: 'thinking' }, 'thinking'),
      expectedType: 'reasoning',
    },
    {
      name: 'command tool call',
      entry: normalized(
        {
          type: 'tool_use',
          tool_name: 'shell',
          action_type: {
            action: 'command_run',
            command: 'pnpm test',
            result: {
              exit_status: { type: 'exit_code', code: 0 },
              output: 'ok',
            },
          },
          status: { status: 'success' },
        },
        'pnpm test'
      ),
      expectedType: 'tool-call',
    },
    {
      name: 'plan',
      entry: normalized({
        type: 'tool_use',
        tool_name: 'plan',
        action_type: {
          action: 'plan_presentation',
          plan: 'Read spec\nPatch code',
        },
        status: { status: 'success' },
      }),
      expectedType: 'plan',
    },
    {
      name: 'usage',
      entry: normalized({
        type: 'token_usage_info',
        total_tokens: 128,
        model_context_window: 2048,
      }),
      expectedType: 'usage',
    },
    {
      name: 'error',
      entry: normalized(
        { type: 'error_message', error_type: { type: 'other' } },
        'boom'
      ),
      expectedType: 'error',
    },
  ])('maps normalized $name entries to $expectedType parts', (fixture) => {
    expect(adaptNormalizedEntry(fixture.entry, fixture.name)?.type).toBe(
      fixture.expectedType
    );
  });

  it('keeps imported agent messages as text parts with the original role', () => {
    const message: ImportedAgentMessage = {
      role: 'tool',
      content: 'tool output',
      created_at: '2026-06-12T00:00:00.000Z',
    };

    expect(adaptImportedAgentMessage(message)).toMatchObject({
      type: 'text',
      role: 'tool',
      text: 'tool output',
      source: 'imported-message',
    });
  });

  it.each([
    {
      name: 'connection status',
      envelope: event(1, {
        kind: 'connection_status_changed',
        snapshot: {
          id: 'connection',
          agent_type: 'codex',
          workspace_id: 'workspace',
          status: 'ready',
          working_dir: 'C:/repo',
          created_at: '2026-06-12T00:00:01.000Z',
          updated_at: '2026-06-12T00:00:01.000Z',
        },
      }),
      expectedType: 'status',
    },
    {
      name: 'terminal',
      envelope: event(2, {
        kind: 'terminal_created',
        terminal: {
          id: 'terminal-1',
          command: 'pnpm',
          args: ['test'],
          cwd: 'C:/repo',
        },
      }),
      expectedType: 'terminal',
    },
    {
      name: 'permission',
      envelope: event(3, {
        kind: 'permission_requested',
        request: {
          id: 'permission-1',
          session_id: 'session',
          title: 'Run tests',
          options: [{ id: 'allow', label: 'Allow' }],
        },
      }),
      expectedType: 'permission',
    },
    {
      name: 'agent message',
      envelope: event(4, {
        kind: 'message_chunk',
        content: { kind: 'text', text: 'hello' },
      }),
      expectedType: 'text',
    },
  ])('maps agent event $name to $expectedType parts', (fixture) => {
    expect(adaptAgentEventEnvelope(fixture.envelope)?.type).toBe(
      fixture.expectedType
    );
  });

  it('adapts mixed source inputs in order', () => {
    const parts = adaptContentParts([
      normalized({ type: 'user_message' }, 'prompt'),
      { role: 'assistant', content: 'imported reply' },
      event(1, {
        kind: 'usage',
        usage: { used: 42, limit: 1024 },
      }),
    ]);

    expect(parts.map((part) => part.type)).toEqual(['text', 'text', 'usage']);
    expect(parts.map((part) => part.source)).toEqual([
      'normalized-entry',
      'imported-message',
      'agent-event',
    ]);
  });
});
