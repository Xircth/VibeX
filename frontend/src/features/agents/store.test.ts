import { describe, expect, it } from 'vitest';
import {
  emptyAgentWorkbenchState,
  hydrateAgentSnapshot,
  reduceAgentEvent,
  stateFromAgentSnapshot,
} from './store';
import type { AgentEventEnvelope, AgentRuntimeSnapshot } from './types';

describe('agent workbench store', () => {
  it('hydrates from runtime snapshot', () => {
    const snapshot: AgentRuntimeSnapshot = {
      sequence: 4,
      registry: [
        {
          agent_type: 'codex',
          registry_id: 'codex-acp',
          name: 'Codex CLI',
          description: 'ACP adapter',
          distribution: {
            kind: 'binary',
            version: '0.16.0',
            cmd: 'codex-acp',
            args: [],
            platforms: [],
          },
        },
      ],
      connections: [],
      sessions: [],
      prompts: [],
      events: [],
    };

    const state = stateFromAgentSnapshot(snapshot);

    expect(state.registry['codex-acp']?.name).toBe('Codex CLI');
    expect(state.lastSequence).toBe(4);
  });

  it('does not hydrate an older snapshot over newer events', () => {
    const state = {
      ...emptyAgentWorkbenchState(),
      lastSequence: 10,
    };
    const snapshot: AgentRuntimeSnapshot = {
      sequence: 9,
      registry: [],
      connections: [],
      sessions: [],
      prompts: [],
      events: [],
    };

    expect(hydrateAgentSnapshot(state, snapshot)).toBe(state);
  });

  it('ignores duplicate or stale events by backend sequence', () => {
    const event: AgentEventEnvelope = {
      sequence: 2,
      workspace_id: 'workspace',
      connection_id: 'connection',
      created_at: new Date().toISOString(),
      event: {
        kind: 'connection_status_changed',
        snapshot: {
          id: 'connection',
          agent_type: 'codex',
          workspace_id: 'workspace',
          status: 'connecting',
          working_dir: 'C:/work',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
    };
    const state = reduceAgentEvent(emptyAgentWorkbenchState(), event);
    const duplicate = reduceAgentEvent(state, event);

    expect(duplicate).toBe(state);
  });

  it('stores prompt starts and prompt completion', () => {
    const started: AgentEventEnvelope = {
      sequence: 1,
      workspace_id: 'workspace',
      connection_id: 'connection',
      session_id: 'session',
      created_at: new Date().toISOString(),
      event: {
        kind: 'prompt_started',
        snapshot: {
          id: 'prompt',
          session_id: 'session',
          status: { kind: 'running' },
          text_preview: 'hello',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
    };
    const finished: AgentEventEnvelope = {
      sequence: 2,
      workspace_id: 'workspace',
      connection_id: 'connection',
      session_id: 'session',
      created_at: new Date().toISOString(),
      event: {
        kind: 'prompt_finished',
        finished: { prompt_id: 'prompt', stop_reason: 'end_turn' },
      },
    };

    const state = reduceAgentEvent(
      reduceAgentEvent(emptyAgentWorkbenchState(), started),
      finished
    );

    expect(state.prompts.prompt?.status).toEqual({
      kind: 'completed',
      stop_reason: 'end_turn',
    });
  });

  it('keeps transcript events by session scope', () => {
    const message: AgentEventEnvelope = {
      sequence: 3,
      workspace_id: 'workspace',
      connection_id: 'connection',
      session_id: 'session',
      created_at: new Date().toISOString(),
      event: {
        kind: 'message_chunk',
        content: { kind: 'text', text: 'hello' },
      },
    };

    const state = reduceAgentEvent(emptyAgentWorkbenchState(), message);

    expect(state.eventsByScope.session).toEqual([message]);
  });

  it('tracks permission requests until a response arrives', () => {
    const requested: AgentEventEnvelope = {
      sequence: 1,
      workspace_id: 'workspace',
      connection_id: 'connection',
      session_id: 'session',
      created_at: new Date().toISOString(),
      event: {
        kind: 'permission_requested',
        request: {
          id: 'permission',
          session_id: 'session',
          title: 'Run command',
          options: [{ id: 'allow', label: 'Allow' }],
        },
      },
    };
    const responded: AgentEventEnvelope = {
      sequence: 2,
      workspace_id: 'workspace',
      connection_id: 'connection',
      session_id: 'session',
      created_at: new Date().toISOString(),
      event: {
        kind: 'permission_responded',
        permission_id: 'permission',
        response: { kind: 'selected', option_id: 'allow' },
      },
    };

    const withPermission = reduceAgentEvent(
      emptyAgentWorkbenchState(),
      requested
    );
    const withoutPermission = reduceAgentEvent(withPermission, responded);

    expect(withPermission.permissions.permission?.title).toBe('Run command');
    expect(withoutPermission.permissions.permission).toBeUndefined();
  });

  it('tracks terminal, usage, and error state by event scope', () => {
    const terminal: AgentEventEnvelope = {
      sequence: 1,
      workspace_id: 'workspace',
      connection_id: 'connection',
      session_id: 'session',
      created_at: new Date().toISOString(),
      event: {
        kind: 'terminal_created',
        terminal: {
          id: 'terminal',
          command: 'pnpm',
          args: ['test'],
        },
      },
    };
    const usage: AgentEventEnvelope = {
      sequence: 2,
      workspace_id: 'workspace',
      connection_id: 'connection',
      session_id: 'session',
      created_at: new Date().toISOString(),
      event: {
        kind: 'usage',
        usage: { used: 42, limit: 100 },
      },
    };
    const error: AgentEventEnvelope = {
      sequence: 3,
      workspace_id: 'workspace',
      connection_id: 'connection',
      session_id: 'session',
      created_at: new Date().toISOString(),
      event: {
        kind: 'error',
        error: { message: 'failed' },
      },
    };

    const state = [terminal, usage, error].reduce(
      reduceAgentEvent,
      emptyAgentWorkbenchState()
    );

    expect(state.terminals.terminal?.command).toBe('pnpm');
    expect(state.usageByScope.session).toEqual({ used: 42, limit: 100 });
    expect(state.errorsByScope.session).toEqual(['failed']);
  });
});
