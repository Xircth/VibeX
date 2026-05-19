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
      opencode
        .getFallbackSlashCommands()
        .some((command) => command.name === 'agents')
    ).toBe(true);
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
      claude
        .getFallbackSlashCommands()
        .some((command) => command.name === 'goal')
    ).toBe(false);
    expect(
      codex
        .getFallbackSlashCommands()
        .some((command) => command.name === 'permissions')
    ).toBe(false);
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

  it('normalizes provider events only at the active provider boundary', () => {
    const codex = getProviderFrontendAdapter('codex');

    expect(
      codex.mapRuntimeEvent({
        provider: 'codex',
        workspace_id: 'workspace-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        event: { method: 'turn/started' },
      })
    ).toEqual([
      {
        type: 'set_status',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        status: 'started',
        raw: { method: 'turn/started' },
      },
    ]);

    expect(
      codex.mapRuntimeEvent({
        provider: 'codex',
        workspace_id: 'workspace-1',
        turn_id: 'queued-turn-1',
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
        event: { text: 'wrong boundary' },
      })[0]
    ).toMatchObject({
      type: 'raw_diagnostic',
      provider: 'codex',
      raw: { reason: 'cross_provider_event_ignored' },
    });
  });
});
