import { describe, expect, it } from 'vitest';
import { buildAgentTranscriptEntries } from './transcript';
import type { AgentEventEnvelope, AgentType } from './types';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';

function event(
  sequence: number,
  event: AgentEventEnvelope['event'],
  overrides: Partial<
    Pick<AgentEventEnvelope, 'connection_id' | 'session_id'>
  > = {}
): AgentEventEnvelope {
  return {
    sequence,
    workspace_id: 'workspace',
    connection_id: overrides.connection_id ?? 'connection',
    session_id: overrides.session_id ?? 'session',
    created_at: `2026-06-11T00:00:0${sequence}.000Z`,
    event,
  };
}

function normalized(entry: PatchTypeWithKey) {
  if (entry.type !== 'NORMALIZED_ENTRY') {
    throw new Error(`Expected normalized entry, got ${entry.type}`);
  }
  return entry.content;
}

describe('agent transcript adapter', () => {
  it('maps ACP prompt and chunks into normalized conversation entries', () => {
    const entries = buildAgentTranscriptEntries([
      event(1, {
        kind: 'prompt_started',
        snapshot: {
          id: 'prompt',
          session_id: 'session',
          status: { kind: 'running' },
          text_preview: 'hello',
          created_at: '2026-06-11T00:00:01.000Z',
          updated_at: '2026-06-11T00:00:01.000Z',
        },
      }),
      event(2, {
        kind: 'message_chunk',
        content: { kind: 'text', text: 'hi' },
      }),
      event(3, {
        kind: 'message_chunk',
        content: { kind: 'text', text: ' there' },
      }),
      event(4, {
        kind: 'thought_chunk',
        content: { kind: 'text', text: 'thinking' },
      }),
    ]);

    expect(entries).toHaveLength(3);
    expect(normalized(entries[0]!).entry_type.type).toBe('user_message');
    expect(normalized(entries[0]!).content).toBe('hello');
    expect(normalized(entries[1]!).entry_type.type).toBe('assistant_message');
    expect(normalized(entries[1]!).content).toBe('hi there');
    expect(normalized(entries[2]!).entry_type.type).toBe('thinking');
  });

  it('renders ACP image chunks with their source uri when available', () => {
    const entries = buildAgentTranscriptEntries([
      event(1, {
        kind: 'message_chunk',
        content: {
          kind: 'image',
          data: 'base64',
          mime_type: 'image/png',
          uri: '.vibe-images/screen.png',
        },
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(normalized(entries[0]!).content).toBe(
      '[image] .vibe-images/screen.png'
    );
  });

  it('maps ACP terminal and permission events into visible entries', () => {
    const entries = buildAgentTranscriptEntries([
      event(1, {
        kind: 'permission_requested',
        request: {
          id: 'perm-1',
          session_id: 'session',
          title: 'Run pnpm test',
          options: [
            { id: 'allow', label: 'Allow once', description: 'AllowOnce' },
            { id: 'reject', label: 'Reject once', description: 'RejectOnce' },
          ],
        },
      }),
      event(2, {
        kind: 'terminal_created',
        terminal: {
          id: 'term-1',
          command: 'pnpm',
          args: ['test'],
          cwd: 'C:/repo',
        },
      }),
      event(3, {
        kind: 'terminal_output',
        output: {
          terminal_id: 'term-1',
          output: 'ok',
          truncated: false,
          exit_status: 0,
        },
      }),
    ]);

    expect(entries).toHaveLength(3);
    expect(normalized(entries[0]!).entry_type.type).toBe('system_message');
    expect(normalized(entries[0]!).content).toBe(
      'Permission requested: Run pnpm test (2 options)'
    );
    expect(normalized(entries[1]!).entry_type.type).toBe('tool_use');
    expect(normalized(entries[1]!).content).toBe('pnpm test');
    expect(normalized(entries[2]!).entry_type.type).toBe('tool_use');
    expect(normalized(entries[2]!).content).toBe('ok');
  });

  it.each<AgentType>([
    'claude_code',
    'codex',
    'open_code',
    'gemini',
    'open_claw',
    'cline',
    'hermes',
  ])(
    'keeps %s ACP conversation output visible without a terminal panel',
    (agentType) => {
      const connectionId = `${agentType}-connection`;
      const sessionId = `${agentType}-session`;
      const entries = buildAgentTranscriptEntries([
        event(
          1,
          {
            kind: 'connection_status_changed',
            snapshot: {
              id: connectionId,
              agent_type: agentType,
              workspace_id: 'workspace',
              status: 'ready',
              working_dir: 'C:/repo',
              created_at: '2026-06-11T00:00:01.000Z',
              updated_at: '2026-06-11T00:00:01.000Z',
            },
          },
          { connection_id: connectionId, session_id: null }
        ),
        event(
          2,
          {
            kind: 'prompt_started',
            snapshot: {
              id: `${agentType}-prompt`,
              session_id: sessionId,
              status: { kind: 'running' },
              text_preview: `${agentType} prompt`,
              created_at: '2026-06-11T00:00:02.000Z',
              updated_at: '2026-06-11T00:00:02.000Z',
            },
          },
          { connection_id: connectionId, session_id: sessionId }
        ),
        event(
          3,
          {
            kind: 'message_chunk',
            content: { kind: 'text', text: `${agentType} answer` },
          },
          { connection_id: connectionId, session_id: sessionId }
        ),
        event(
          4,
          {
            kind: 'thought_chunk',
            content: { kind: 'text', text: `${agentType} thought` },
          },
          { connection_id: connectionId, session_id: sessionId }
        ),
        event(
          5,
          {
            kind: 'tool_call',
            tool_call: {
              id: `${agentType}-tool`,
              title: `${agentType} tool`,
              kind: 'command',
            },
          },
          { connection_id: connectionId, session_id: sessionId }
        ),
        event(
          6,
          {
            kind: 'terminal_created',
            terminal: {
              id: `${agentType}-terminal`,
              command: 'echo',
              args: [agentType],
              cwd: 'C:/repo',
            },
          },
          { connection_id: connectionId, session_id: sessionId }
        ),
        event(
          7,
          {
            kind: 'terminal_output',
            output: {
              terminal_id: `${agentType}-terminal`,
              output: `${agentType} terminal output`,
              truncated: false,
              exit_status: 0,
            },
          },
          { connection_id: connectionId, session_id: sessionId }
        ),
        event(
          8,
          {
            kind: 'permission_requested',
            request: {
              id: `${agentType}-permission`,
              session_id: sessionId,
              title: `${agentType} permission`,
              options: [{ id: 'allow', label: 'Allow' }],
            },
          },
          { connection_id: connectionId, session_id: sessionId }
        ),
      ]);

      const visibleContent = entries
        .filter(
          (
            entry
          ): entry is Extract<PatchTypeWithKey, { type: 'NORMALIZED_ENTRY' }> =>
            entry.type === 'NORMALIZED_ENTRY'
        )
        .map((entry) => entry.content.content);

      expect(visibleContent).toEqual([
        `${agentType} prompt`,
        `${agentType} answer`,
        `${agentType} thought`,
        `${agentType} tool`,
        `echo ${agentType}`,
        `${agentType} terminal output`,
        `Permission requested: ${agentType} permission (1 option)`,
      ]);
    }
  );
});
