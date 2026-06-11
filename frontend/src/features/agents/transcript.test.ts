import { describe, expect, it } from 'vitest';
import { buildAgentTranscriptEntries } from './transcript';
import type { AgentEventEnvelope } from './types';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';

function event(
  sequence: number,
  event: AgentEventEnvelope['event']
): AgentEventEnvelope {
  return {
    sequence,
    workspace_id: 'workspace',
    connection_id: 'connection',
    session_id: 'session',
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
});
