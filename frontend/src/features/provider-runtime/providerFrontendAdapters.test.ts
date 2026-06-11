import { BaseCodingAgent } from 'shared/types';
import {
  getProviderFrontendAdapter,
  getProviderFrontendAdapterByExecutor,
  providerIdFromExecutor,
} from './providerFrontendAdapters';
import { buildProviderRuntimeTurnRequest } from './sendProviderRuntimeTurn';

describe('provider frontend adapters', () => {
  it('maps supported executors to isolated provider ids', () => {
    expect(providerIdFromExecutor(BaseCodingAgent.CLAUDE_CODE)).toBe('claude');
    expect(providerIdFromExecutor(BaseCodingAgent.CODEX)).toBe('codex');
    expect(providerIdFromExecutor(BaseCodingAgent.OPENCODE)).toBe('opencode');
  });

  it('keeps only commands with visible chat behavior in provider catalogs', () => {
    const claude = getProviderFrontendAdapter('claude');
    const codex = getProviderFrontendAdapter('codex');
    const opencode = getProviderFrontendAdapter('opencode');

    expect(
      claude
        .getFallbackSlashCommands()
        .some((command) => command.name === 'permissions')
    ).toBe(false);
    expect(
      claude
        .getFallbackSlashCommands()
        .some((command) => command.name === 'mcp')
    ).toBe(false);
    expect(
      codex
        .getFallbackSlashCommands()
        .some((command) => command.name === 'goal')
    ).toBe(true);
    expect(
      claude
        .getFallbackSlashCommands()
        .some((command) => command.name === 'goal')
    ).toBe(true);
    expect(
      opencode
        .getFallbackSlashCommands()
        .some((command) => command.name === 'agents')
    ).toBe(false);
    expect(
      opencode
        .getFallbackSlashCommands()
        .some((command) => command.name === 'compact')
    ).toBe(true);
    expect(
      opencode
        .getFallbackSlashCommands()
        .some((command) => command.name === 'plan')
    ).toBe(false);
    expect(
      opencode
        .getFallbackSlashCommands()
        .some((command) => command.name === 'build')
    ).toBe(false);
    expect(
      opencode
        .getFallbackSlashCommands()
        .some((command) => command.name === 'status')
    ).toBe(false);
    expect(
      codex.getFallbackSlashCommands().some((command) => command.name === 'mcp')
    ).toBe(false);
    expect(
      codex
        .getFallbackSlashCommands()
        .some((command) => command.name === 'model')
    ).toBe(false);
    expect(
      opencode
        .getFallbackSlashCommands()
        .some((command) => command.name === 'mcp')
    ).toBe(false);
    expect(
      opencode
        .getFallbackSlashCommands()
        .some((command) => command.name === 'config')
    ).toBe(false);
    expect(
      opencode
        .getFallbackSlashCommands()
        .some((command) => command.name === 'model')
    ).toBe(false);

    expect(
      codex
        .getFallbackSlashCommands()
        .some((command) => command.name === 'permissions')
    ).toBe(false);
  });

  it('does not overstate Codex request-response capability support', () => {
    const codex = getProviderFrontendAdapter('codex');
    const capabilities = codex.getCapabilities();

    expect(capabilities.approvals.state).toBe('partial');
    expect(capabilities.user_input_requests.state).toBe('partial');
  });

  it('builds provider-owned turn requests without cross-provider options', () => {
    const codex = getProviderFrontendAdapterByExecutor(BaseCodingAgent.CODEX);

    expect(
      codex?.buildTurnRequest(
        { text: 'hello', images: ['image-1'] },
        { workspaceId: 'workspace-1', sessionId: 'session-1', model: 'gpt-5.5' }
      )
    ).toEqual({
      provider: 'codex',
      workspace_id: 'workspace-1',
      thread_id: undefined,
      session_id: 'session-1',
      text: 'hello',
      model: 'gpt-5.5',
      images: ['image-1'],
      provider_options: {},
    });
  });

  it('builds normal composer turns through provider runtime requests', () => {
    expect(
      buildProviderRuntimeTurnRequest({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        executorProfileId: {
          executor: BaseCodingAgent.CLAUDE_CODE,
          variant: 'sonnet',
        },
        text: 'hello claude',
        providerOptions: { permission_mode: 'acceptEdits' },
      })
    ).toEqual({
      provider: 'claude',
      workspace_id: 'workspace-1',
      executor_profile_id: {
        executor: BaseCodingAgent.CLAUDE_CODE,
        variant: 'sonnet',
      },
      thread_id: undefined,
      session_id: 'session-1',
      text: 'hello claude',
      model: undefined,
      images: [],
      provider_options: { permission_mode: 'acceptEdits' },
    });
  });

  it('passes executor profile model overrides into provider runtime turns', () => {
    expect(
      buildProviderRuntimeTurnRequest({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        executorProfileId: {
          executor: BaseCodingAgent.OPENCODE,
          variant: null,
          model: 'anthropic/claude-sonnet-4-5',
        },
        text: 'hello opencode',
      })
    ).toMatchObject({
      provider: 'opencode',
      model: 'anthropic/claude-sonnet-4-5',
      executor_profile_id: {
        executor: BaseCodingAgent.OPENCODE,
        variant: null,
        model: 'anthropic/claude-sonnet-4-5',
      },
    });
  });

  it('passes Codex reasoning overrides into provider runtime turns', () => {
    expect(
      buildProviderRuntimeTurnRequest({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        executorProfileId: {
          executor: BaseCodingAgent.CODEX,
          variant: null,
          model: 'gpt-5.5',
          reasoning_effort: 'low',
        } as {
          executor: BaseCodingAgent;
          variant: null;
          model: string;
          reasoning_effort: 'low';
        },
        text: 'hello codex',
      })
    ).toMatchObject({
      provider: 'codex',
      executor_profile_id: {
        executor: BaseCodingAgent.CODEX,
        reasoning_effort: 'low',
      },
      provider_options: {
        effort: 'low',
      },
    });
  });

  it('preserves Codex skill and app mention provider options for app-server input items', () => {
    expect(
      buildProviderRuntimeTurnRequest({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        executorProfileId: {
          executor: BaseCodingAgent.CODEX,
          variant: 'GPT_5_5',
        },
        text: '$skill-creator add docs',
        providerOptions: {
          skills: [
            {
              name: 'skill-creator',
              path: 'C:\\Users\\me\\.codex\\skills\\skill-creator\\SKILL.md',
            },
          ],
          apps: [
            {
              name: 'Demo App',
              id: 'demo-app',
            },
          ],
        },
      }).provider_options
    ).toMatchObject({
      skills: [
        {
          name: 'skill-creator',
        },
      ],
      apps: [
        {
          id: 'demo-app',
        },
      ],
    });
  });

  it('extracts markdown images into provider runtime attachments', () => {
    expect(
      buildProviderRuntimeTurnRequest({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        executorProfileId: {
          executor: BaseCodingAgent.CODEX,
          variant: null,
        },
        text: 'analyze this\n\n![shot](.vibe-images/shot.png)',
      }).images
    ).toEqual(['.vibe-images/shot.png']);
  });

  it('keeps display text separate from backend text for structured composer tokens', () => {
    expect(
      buildProviderRuntimeTurnRequest({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        executorProfileId: {
          executor: BaseCodingAgent.CODEX,
          variant: null,
        },
        text: 'Review src/App.tsx with $plan',
        displayText: 'Review @src/App.tsx with $plan',
      })
    ).toMatchObject({
      text: 'Review src/App.tsx with $plan',
      provider_options: {
        display_text: 'Review @src/App.tsx with $plan',
      },
    });
  });

  it('maps backend-normalized provider status only at the active provider boundary', () => {
    const codex = getProviderFrontendAdapter('codex');

    expect(
      codex.mapRuntimeEvent({
        provider: 'codex',
        workspace_id: 'workspace-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        normalized: [{ kind: 'turn_started' }],
        event: { method: 'turn/started' },
      })
    ).toEqual([
      {
        type: 'set_status',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        status: 'started',
        raw: { kind: 'turn_started' },
      },
    ]);

    expect(
      codex.mapRuntimeEvent({
        provider: 'codex',
        workspace_id: 'workspace-1',
        turn_id: 'queued-turn-1',
        normalized: [],
        event: { method: 'turn/queued' },
      })[0]
    ).toMatchObject({
      type: 'set_status',
      provider: 'codex',
      turnId: 'queued-turn-1',
      status: 'started',
    });

    expect(
      codex.mapRuntimeEvent({
        provider: 'claude',
        workspace_id: 'workspace-1',
        normalized: [{ kind: 'assistant_text_delta', text: 'wrong boundary' }],
        event: { text: 'wrong boundary' },
      })[0]
    ).toMatchObject({
      type: 'raw_diagnostic',
      provider: 'codex',
      raw: { reason: 'cross_provider_event_ignored' },
    });
  });

  it('maps backend-normalized text, diagnostics, and tool updates', () => {
    const codex = getProviderFrontendAdapter('codex');

    expect(
      codex.mapRuntimeEvent({
        provider: 'codex',
        workspace_id: 'workspace-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        normalized: [
          {
            kind: 'assistant_text_delta',
            id: 'assistant-1',
            text: 'assistant text',
          },
        ],
        event: {
          method: 'item/agentMessage/delta',
          params: { delta: 'assistant text' },
        },
      })[0]
    ).toMatchObject({
      type: 'append_text',
      text: 'assistant text',
    });

    expect(
      codex.mapRuntimeEvent({
        provider: 'codex',
        workspace_id: 'workspace-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        normalized: [
          {
            kind: 'diagnostic',
            level: 'warning',
            message: 'stderr noise',
          },
        ],
        event: {
          method: 'process/outputDelta',
          params: { stream: 'stderr', delta: 'stderr noise' },
        },
      })[0]
    ).toMatchObject({
      type: 'raw_diagnostic',
      raw: {
        kind: 'diagnostic',
        level: 'warning',
        message: 'stderr noise',
      },
    });

    expect(
      codex.mapRuntimeEvent({
        provider: 'codex',
        workspace_id: 'workspace-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        normalized: [
          {
            kind: 'tool_update',
            id: 'tool-1',
            tool_name: 'shell',
            status: 'running',
          },
        ],
        event: {
          method: 'command/exec/started',
        },
      })[0]
    ).toMatchObject({
      type: 'raw_diagnostic',
      raw: {
        kind: 'tool_update',
        id: 'tool-1',
        tool_name: 'shell',
        status: 'running',
      },
    });
  });

  it('treats raw Claude SDK payloads as diagnostics unless backend normalizes them', () => {
    const claude = getProviderFrontendAdapter('claude');

    expect(
      claude.mapRuntimeEvent({
        provider: 'claude',
        workspace_id: 'workspace-1',
        thread_id: 'claude-session-1',
        normalized: [],
        event: {
          type: 'sdk_event',
          text: 'live chunk',
          event: {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: {
                type: 'text_delta',
                text: 'live chunk',
              },
            },
          },
        },
      })[0]
    ).toMatchObject({
      type: 'raw_diagnostic',
    });

    expect(
      claude.mapRuntimeEvent({
        provider: 'claude',
        workspace_id: 'workspace-1',
        thread_id: 'claude-session-1',
        normalized: [
          {
            kind: 'assistant_text_snapshot',
            text: 'final Claude reply',
          },
        ],
        event: {
          type: 'sdk_event',
          text: 'final Claude reply',
          event: {
            type: 'result',
            subtype: 'success',
            result: 'final Claude reply',
          },
        },
      })[0]
    ).toMatchObject({
      type: 'append_text',
      text: 'final Claude reply',
    });

    expect(
      claude.mapRuntimeEvent({
        provider: 'claude',
        workspace_id: 'workspace-1',
        normalized: [],
        event: {
          type: 'sdk_event',
          text: 'tool stdout should not render',
          event: {
            type: 'tool_result',
            content: [{ type: 'text', text: 'tool stdout should not render' }],
          },
        },
      })[0]
    ).toMatchObject({
      type: 'raw_diagnostic',
    });
  });

  it('does not recursively parse raw assistant payloads in the frontend', () => {
    const codex = getProviderFrontendAdapter('codex');

    expect(
      codex.mapRuntimeEvent({
        provider: 'codex',
        workspace_id: 'workspace-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        normalized: [],
        event: {
          type: 'agentMessage',
          content: [
            {
              type: 'image_generation_call',
              result: 'abc123',
            },
          ],
        },
      })[0]
    ).toMatchObject({
      type: 'raw_diagnostic',
    });
  });

  it('maps OpenCode visible text only from backend-normalized events', () => {
    const opencode = getProviderFrontendAdapter('opencode');

    expect(
      opencode.mapRuntimeEvent({
        provider: 'opencode',
        workspace_id: 'workspace-1',
        thread_id: 'session-1',
        normalized: [],
        event: {
          type: 'opencode_sdk_event',
          event: {
            type: 'message.part.updated',
            properties: {
              sessionID: 'session-1',
              part: {
                id: 'user-part-1',
                messageID: 'user-message-1',
                type: 'text',
                text: 'hello opencode',
              },
            },
          },
        },
      })[0]
    ).toMatchObject({
      type: 'raw_diagnostic',
    });

    expect(
      opencode.mapRuntimeEvent({
        provider: 'opencode',
        workspace_id: 'workspace-1',
        thread_id: 'session-1',
        normalized: [],
        event: {
          type: 'opencode_sdk_event',
          event: {
            type: 'message.part.updated',
            properties: {
              delta: 'hello ',
              part: {
                id: 'part-1',
                type: 'text',
                text: 'hello world',
              },
            },
          },
        },
      })[0]
    ).toMatchObject({ type: 'raw_diagnostic' });

    expect(
      opencode.mapRuntimeEvent({
        provider: 'opencode',
        workspace_id: 'workspace-1',
        thread_id: 'session-1',
        normalized: [],
        event: {
          type: 'opencode_sdk_event',
          event: {
            type: 'message.part.delta',
            properties: {
              sessionID: 'session-1',
              messageID: 'assistant-message-1',
              partID: 'text-part-1',
              partType: 'text',
              field: 'text',
              delta: 'chunk text',
            },
          },
        },
      })[0]
    ).toMatchObject({ type: 'raw_diagnostic' });

    expect(
      opencode.mapRuntimeEvent({
        provider: 'opencode',
        workspace_id: 'workspace-1',
        thread_id: 'session-1',
        normalized: [],
        event: {
          type: 'opencode_sdk_event',
          event: {
            type: 'session.next.text.delta',
            properties: {
              sessionID: 'session-1',
              delta: 'next text',
            },
          },
        },
      })[0]
    ).toMatchObject({ type: 'raw_diagnostic' });

    expect(
      opencode.mapRuntimeEvent({
        provider: 'opencode',
        workspace_id: 'workspace-1',
        thread_id: 'session-1',
        normalized: [],
        event: {
          type: 'opencode_sdk_event',
          event: {
            type: 'message.part.delta',
            properties: {
              sessionID: 'session-1',
              messageID: 'assistant-message-1',
              partID: 'reasoning-part-1',
              partType: 'reasoning',
              field: 'text',
              delta: 'The user is asking who I am.',
            },
          },
        },
      })[0]
    ).toMatchObject({ type: 'raw_diagnostic' });

    expect(
      opencode.mapRuntimeEvent({
        provider: 'opencode',
        workspace_id: 'workspace-1',
        thread_id: 'session-1',
        normalized: [
          {
            kind: 'assistant_text_snapshot',
            text: 'final OpenCode reply',
          },
          {
            kind: 'turn_completed',
            thread_id: 'session-1',
          },
        ],
        event: {
          type: 'opencode_sdk_response',
          sessionID: 'session-1',
          response: {
            info: {
              role: 'assistant',
            },
            parts: [
              { type: 'step-start' },
              { type: 'text', text: 'final OpenCode reply' },
              { type: 'step-finish' },
            ],
          },
        },
      })[0]
    ).toMatchObject({
      type: 'append_text',
      text: 'final OpenCode reply',
    });

    expect(
      opencode.mapRuntimeEvent({
        provider: 'opencode',
        workspace_id: 'workspace-1',
        thread_id: 'session-1',
        normalized: [
          {
            kind: 'assistant_text_snapshot',
            text: 'final OpenCode reply',
          },
          {
            kind: 'turn_completed',
            thread_id: 'session-1',
          },
        ],
        event: {
          type: 'opencode_sdk_response',
        },
      })[1]
    ).toMatchObject({
      type: 'set_status',
      status: 'completed',
    });
  });
});
