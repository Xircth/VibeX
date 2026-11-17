import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbConversationDetail, ExecutorProfileId } from 'shared/types';
import { sessionListAgentKey } from '@/components/kanban/session-hub/utils';
import { toast } from '@/components/ui/toast';
import { conversationApi } from '@/features/conversation/conversationApi';
import { getConversationHandoffPending } from '@/features/conversation/conversationTimelineRegistry';
import {
  useConversationSessionFacts,
  useConversationTimeline,
} from '@/features/conversation/useConversationTimeline';
import type { SessionSummary as SessionSummaryRecord } from '@/lib/api';
import { getMruProviderInstanceId } from '@/lib/providerInstanceMru';
import { providerInstancesApi } from '@/lib/providerInstancesApi';
import { useComposerEngineHandoff } from './ComposerEngineHandoffControl';

function SessionFactsProbe({ sessionId }: { sessionId: string | null }) {
  useConversationTimeline(sessionId);
  const facts = useConversationSessionFacts(sessionId);
  return (
    <div
      data-testid="session-facts-probe"
      data-agent-id={facts.agentId ?? ''}
      data-model={facts.model ?? ''}
    />
  );
}

function HandoffHarness({
  sessionId,
  currentExecutor,
  currentProviderInstanceId = null,
  onApply,
  onApplyInstance,
  resolveTargetInstanceIdForAgent,
}: {
  sessionId: string | null;
  currentExecutor: string;
  currentProviderInstanceId?: string | null;
  onApply: (profile: ExecutorProfileId | null) => void;
  onApplyInstance?: (instanceId: string | null, targetAgentId?: string | null) => void;
  resolveTargetInstanceIdForAgent?: (agentId: string) => string | null;
}) {
  const controller = useComposerEngineHandoff({
    sessionId,
    currentExecutor,
    currentProviderInstanceId,
    onApplyExecutorProfile: onApply,
    onApplyProviderInstanceId: onApplyInstance,
    resolveTargetInstanceIdForAgent,
  });

  return (
    <HotkeysProvider initiallyActiveScopes={['dialog', 'kanban', 'projects']}>
      <button
        type="button"
        data-testid="switch-to-codex"
        onClick={() =>
          controller.handleChangeExecutorProfile({
            executor: 'CODEX',
            variant: null,
            model: null,
            fast_mode: null,
          })
        }
      >
        Switch to Codex
      </button>
      <button
        type="button"
        data-testid="switch-instance-personal"
        onClick={() =>
          controller.handleChangeProviderInstance('claude-personal')
        }
      >
        Switch Instance Personal
      </button>
      <button
        type="button"
        data-testid="switch-instance-local"
        onClick={() => controller.handleChangeProviderInstance('local')}
      >
        Switch Instance Local
      </button>
      <SessionFactsProbe sessionId={sessionId} />
    </HotkeysProvider>
  );
}

function makeDetail(
  conversationId: string,
  agentId: string | null,
  model: string | null
): DbConversationDetail {
  return {
    summary: {
      id: conversationId,
      workspace_id: 'ws-1',
      task_id: null,
      title: 'Test Session',
      title_locked: false,
      status: 'todo',
      agent_id: agentId,
      model,
      external_session_id: null,
      message_count: 0n,
      pinned_at: null,
      parent_session_id: null,
      parent_tool_use_id: null,
      delegation_call_id: null,
      created_at: '2026-11-14T00:00:00Z',
      updated_at: '2026-11-14T00:00:00Z',
    },
    turns: [],
    timeline: {
      conversation_id: conversationId,
      last_sequence: 0n,
      rows: [],
    },
    turns_offset: 0,
    turns_total: 0,
    user_turns_before_offset: 0,
    projection_version: 1,
    session_config_options: model
      ? [
          {
            key: 'model',
            label: 'Model',
            category: 'model',
            value: model,
            choices: [],
          },
        ]
      : [],
  } as unknown as DbConversationDetail;
}

function makeSummaryRecord(
  sessionId: string,
  executor: string,
  agentId: string | null,
  model: string | null
): SessionSummaryRecord {
  return {
    id: sessionId,
    workspace_id: 'ws-1',
    task_id: null,
    name: 'Test Session',
    status: 'todo',
    executor,
    agent_id: agentId,
    model,
    created_at: '2026-11-14T00:00:00Z',
    updated_at: '2026-11-14T00:00:00Z',
    first_prompt: null,
    is_running: false,
    display_name: 'Test Session',
    workspace_name: 'main',
    workspace_branch: 'main',
    continuity_mode: 'new_session',
    pinned_at: null,
    collaboration: null,
  };
}

describe('ComposerEngineHandoffControl', () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  const trackSpy = <T extends { mockRestore: () => void }>(spy: T): T => {
    spies.push(spy);
    return spy;
  };

  afterEach(() => {
    localStorage.clear();
    while (spies.length > 0) {
      spies.pop()?.mockRestore();
    }
  });

  it('switches provider instance via confirmEngineHandoff, records MRU without calling setDefault, and sends local when resetting', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['session', 'conv-inst-1'], {
      id: 'conv-inst-1',
      workspace_id: 'ws-1',
      task_id: null,
      name: 'Test Session',
      initial_prompt: null,
      status: 'todo',
      executor: 'CLAUDE_CODE',
      external_session_id: null,
      agent_id: 'claude_code',
      provider_instance_id: null,
      parent_session_id: null,
      parent_tool_use_id: null,
      delegation_call_id: null,
      created_at: '2026-11-14T00:00:00Z',
      updated_at: '2026-11-14T00:00:00Z',
    });
    trackSpy(
      vi
        .spyOn(conversationApi, 'detail')
        .mockResolvedValue(makeDetail('conv-inst-1', 'claude_code', null))
    );
    trackSpy(
      vi.spyOn(conversationApi, 'touch').mockResolvedValue({
        ok: true,
        idleTimeoutSecs: 0,
      })
    );
    const setDefaultSpy = trackSpy(
      vi.spyOn(providerInstancesApi, 'setDefault').mockResolvedValue(undefined)
    );
    const confirmSpy = trackSpy(
      vi
        .spyOn(conversationApi, 'confirmEngineHandoff')
        .mockResolvedValue(undefined)
    );
    const onApply = vi.fn();
    const onApplyInstance = vi.fn();

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <HandoffHarness
          sessionId="conv-inst-1"
          currentExecutor="CLAUDE_CODE"
          currentProviderInstanceId={null}
          onApply={onApply}
          onApplyInstance={onApplyInstance}
        />
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByTestId('switch-instance-personal'));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith({
        conversationId: 'conv-inst-1',
        targetEngine: 'CLAUDE_CODE',
        targetProviderInstanceId: 'claude-personal',
      });
    });
    expect(setDefaultSpy).not.toHaveBeenCalled();
    expect(getMruProviderInstanceId('claude_code')).toBe('claude-personal');
    expect(onApplyInstance).toHaveBeenCalledWith(
      'claude-personal',
      'CLAUDE_CODE'
    );
    expect(
      queryClient.getQueryData<{ provider_instance_id: string | null }>([
        'session',
        'conv-inst-1',
      ])?.provider_instance_id
    ).toBe('claude-personal');

    rerender(
      <QueryClientProvider client={queryClient}>
        <HandoffHarness
          sessionId="conv-inst-1"
          currentExecutor="CLAUDE_CODE"
          currentProviderInstanceId="claude-personal"
          onApply={onApply}
          onApplyInstance={onApplyInstance}
        />
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByTestId('switch-instance-local'));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenLastCalledWith({
        conversationId: 'conv-inst-1',
        targetEngine: 'CLAUDE_CODE',
        targetProviderInstanceId: 'local',
      });
    });
    expect(getMruProviderInstanceId('claude_code')).toBe('local');
    expect(onApplyInstance).toHaveBeenLastCalledWith(null, 'CLAUDE_CODE');
    expect(
      queryClient.getQueryData<{ provider_instance_id: string | null }>([
        'session',
        'conv-inst-1',
      ])?.provider_instance_id
    ).toBeNull();
  });

  it('rolls back provider instance cache and notifies error when confirmEngineHandoff rejects on instance switch', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['session', 'conv-inst-err'], {
      id: 'conv-inst-err',
      workspace_id: 'ws-1',
      task_id: null,
      name: 'Test Session',
      initial_prompt: null,
      status: 'todo',
      executor: 'CLAUDE_CODE',
      external_session_id: null,
      agent_id: 'claude_code',
      provider_instance_id: null,
      parent_session_id: null,
      parent_tool_use_id: null,
      delegation_call_id: null,
      created_at: '2026-11-14T00:00:00Z',
      updated_at: '2026-11-14T00:00:00Z',
    });
    trackSpy(
      vi
        .spyOn(conversationApi, 'detail')
        .mockResolvedValue(makeDetail('conv-inst-err', 'claude_code', null))
    );
    trackSpy(
      vi.spyOn(conversationApi, 'touch').mockResolvedValue({
        ok: true,
        idleTimeoutSecs: 0,
      })
    );
    trackSpy(
      vi
        .spyOn(conversationApi, 'confirmEngineHandoff')
        .mockRejectedValue(new Error('Instance handoff failed'))
    );
    const toastErrorSpy = trackSpy(
      vi.spyOn(toast, 'error').mockImplementation(() => '')
    );
    const onApplyInstance = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <HandoffHarness
          sessionId="conv-inst-err"
          currentExecutor="CLAUDE_CODE"
          currentProviderInstanceId={null}
          onApply={vi.fn()}
          onApplyInstance={onApplyInstance}
        />
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByTestId('switch-instance-personal'));

    await waitFor(() => {
      expect(toastErrorSpy).toHaveBeenCalledWith('Instance handoff failed');
      expect(onApplyInstance).toHaveBeenLastCalledWith(null, 'CLAUDE_CODE');
    });
    expect(
      queryClient.getQueryData<{ provider_instance_id: string | null }>([
        'session',
        'conv-inst-err',
      ])?.provider_instance_id
    ).toBeNull();
  });

  it('forwards resolved MRU instance when switching to a different agent', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    trackSpy(
      vi
        .spyOn(conversationApi, 'detail')
        .mockResolvedValue(makeDetail('conv-cross-inst', 'claude_code', null))
    );
    trackSpy(
      vi.spyOn(conversationApi, 'touch').mockResolvedValue({
        ok: true,
        idleTimeoutSecs: 0,
      })
    );
    const confirmSpy = trackSpy(
      vi
        .spyOn(conversationApi, 'confirmEngineHandoff')
        .mockResolvedValue(undefined)
    );
    const onApply = vi.fn();
    const onApplyInstance = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <HandoffHarness
          sessionId="conv-cross-inst"
          currentExecutor="CLAUDE_CODE"
          onApply={onApply}
          onApplyInstance={onApplyInstance}
          resolveTargetInstanceIdForAgent={(agentId) =>
            agentId === 'CODEX' ? 'codex-work' : null
          }
        />
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByTestId('switch-to-codex'));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith({
        conversationId: 'conv-cross-inst',
        targetEngine: 'CODEX',
        targetProviderInstanceId: 'codex-work',
      });
    });
    expect(onApplyInstance).toHaveBeenCalledWith('codex-work', 'CODEX');
    expect(onApply).toHaveBeenCalledWith({
      executor: 'CODEX',
      variant: null,
      model: null,
      fast_mode: null,
    });
  });

  it('switches engines directly without previewing or opening a dialog and syncs session list + Bot/Session details', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      ['workspaceSessions', 'ws-1', 'summaries'],
      [
        makeSummaryRecord(
          'conv-active-1',
          'CLAUDE_CODE',
          'claude_code',
          'claude-sonnet-4-6'
        ),
      ]
    );
    trackSpy(
      vi
        .spyOn(conversationApi, 'detail')
        .mockResolvedValue(
          makeDetail('conv-active-1', 'claude_code', 'claude-sonnet-4-6')
        )
    );
    trackSpy(
      vi.spyOn(conversationApi, 'touch').mockResolvedValue({
        ok: true,
        idleTimeoutSecs: 0,
      })
    );
    const previewSpy = trackSpy(
      vi.spyOn(conversationApi, 'previewEngineHandoff')
    );
    const confirmSpy = trackSpy(
      vi
        .spyOn(conversationApi, 'confirmEngineHandoff')
        .mockResolvedValue(undefined)
    );
    const onApply = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <HandoffHarness
          sessionId="conv-active-1"
          currentExecutor="CLAUDE_CODE"
          onApply={onApply}
        />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('session-facts-probe')).toHaveAttribute(
        'data-agent-id',
        'claude_code'
      );
    });

    fireEvent.click(screen.getByTestId('switch-to-codex'));

    expect(previewSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('engine-handoff-dialog')).toBeNull();

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith({
        conversationId: 'conv-active-1',
        targetEngine: 'CODEX',
      });
      expect(onApply).toHaveBeenCalledWith({
        executor: 'CODEX',
        variant: null,
        model: null,
        fast_mode: null,
      });
    });

    const cachedSummaries = queryClient.getQueryData<SessionSummaryRecord[]>([
      'workspaceSessions',
      'ws-1',
      'summaries',
    ]);
    expect(
      sessionListAgentKey({
        executor: cachedSummaries?.[0]?.executor ?? null,
        agentId: cachedSummaries?.[0]?.agent_id,
      })
    ).toBe('codex');
    expect(cachedSummaries?.[0]?.model).toBeNull();
    expect(screen.getByTestId('session-facts-probe')).toHaveAttribute(
      'data-agent-id',
      'codex'
    );
    expect(screen.getByTestId('session-facts-probe')).toHaveAttribute(
      'data-model',
      ''
    );
  });

  it('persists and syncs session list icon + Bot/Session details when switching Agent on a 0-turn session without opening handoff dialog', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      ['workspaceSessions', 'ws-1', 'summaries'],
      [makeSummaryRecord('conv-empty-1', 'CLAUDE_CODE', null, null)]
    );
    trackSpy(
      vi
        .spyOn(conversationApi, 'detail')
        .mockResolvedValue(makeDetail('conv-empty-1', null, null))
    );
    trackSpy(
      vi.spyOn(conversationApi, 'touch').mockResolvedValue({
        ok: true,
        idleTimeoutSecs: 0,
      })
    );
    const confirmSpy = trackSpy(
      vi
        .spyOn(conversationApi, 'confirmEngineHandoff')
        .mockResolvedValue(undefined)
    );
    const onApply = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <HandoffHarness
          sessionId="conv-empty-1"
          currentExecutor="CLAUDE_CODE"
          onApply={onApply}
        />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(conversationApi.detail).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByTestId('switch-to-codex'));

    expect(screen.queryByTestId('engine-handoff-dialog')).toBeNull();
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith({
        conversationId: 'conv-empty-1',
        targetEngine: 'CODEX',
      });
      expect(onApply).toHaveBeenCalledWith({
        executor: 'CODEX',
        variant: null,
        model: null,
        fast_mode: null,
      });
    });

    const cachedSummaries = queryClient.getQueryData<SessionSummaryRecord[]>([
      'workspaceSessions',
      'ws-1',
      'summaries',
    ]);
    expect(
      sessionListAgentKey({
        executor: cachedSummaries?.[0]?.executor ?? null,
        agentId: cachedSummaries?.[0]?.agent_id,
      })
    ).toBe('codex');
    expect(screen.getByTestId('session-facts-probe')).toHaveAttribute(
      'data-agent-id',
      'codex'
    );
  });

  it('rolls back session caches and executor profile when confirmEngineHandoff fails with a real error', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      ['workspaceSessions', 'ws-1', 'summaries'],
      [makeSummaryRecord('conv-empty-err', 'CLAUDE_CODE', 'claude_code', null)]
    );
    trackSpy(
      vi
        .spyOn(conversationApi, 'detail')
        .mockResolvedValue(makeDetail('conv-empty-err', 'claude_code', null))
    );
    trackSpy(
      vi.spyOn(conversationApi, 'touch').mockResolvedValue({
        ok: true,
        idleTimeoutSecs: 0,
      })
    );
    trackSpy(
      vi
        .spyOn(conversationApi, 'confirmEngineHandoff')
        .mockRejectedValue(new Error('Engine handoff rejected'))
    );
    const toastErrorSpy = trackSpy(
      vi.spyOn(toast, 'error').mockImplementation(() => '')
    );
    const onApply = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <HandoffHarness
          sessionId="conv-empty-err"
          currentExecutor="CLAUDE_CODE"
          onApply={onApply}
        />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('session-facts-probe')).toHaveAttribute(
        'data-agent-id',
        'claude_code'
      );
    });

    fireEvent.click(screen.getByTestId('switch-to-codex'));

    await waitFor(() => {
      expect(toastErrorSpy).toHaveBeenCalledWith('Engine handoff rejected');
      expect(onApply).toHaveBeenLastCalledWith({
        executor: 'CLAUDE_CODE',
        variant: null,
      });
    });

    const cachedSummaries = queryClient.getQueryData<SessionSummaryRecord[]>([
      'workspaceSessions',
      'ws-1',
      'summaries',
    ]);
    expect(
      sessionListAgentKey({
        executor: cachedSummaries?.[0]?.executor ?? null,
        agentId: cachedSummaries?.[0]?.agent_id,
      })
    ).toBe('claude_code');
    expect(screen.getByTestId('session-facts-probe')).toHaveAttribute(
      'data-agent-id',
      'claude_code'
    );
  });

  it('serializes beginBind and touch until confirmEngineHandoff resolves', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    trackSpy(
      vi
        .spyOn(conversationApi, 'detail')
        .mockResolvedValue(makeDetail('conv-serial-1', 'claude_code', null))
    );
    const ensureControlsSpy = trackSpy(
      vi.spyOn(conversationApi, 'ensureSessionControls').mockResolvedValue({
        modes: [],
        current_mode: null,
        config_options: [],
      })
    );
    const touchSpy = trackSpy(
      vi.spyOn(conversationApi, 'touch').mockResolvedValue({
        ok: true,
        idleTimeoutSecs: 0,
      })
    );

    let resolveConfirm: () => void = () => {};
    trackSpy(
      vi.spyOn(conversationApi, 'confirmEngineHandoff').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveConfirm = resolve;
          })
      )
    );
    const onApply = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <HandoffHarness
          sessionId="conv-serial-1"
          currentExecutor="CLAUDE_CODE"
          onApply={onApply}
        />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(ensureControlsSpy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(touchSpy).toHaveBeenCalledTimes(1);
    });

    ensureControlsSpy.mockClear();
    touchSpy.mockClear();

    fireEvent.click(screen.getByTestId('switch-to-codex'));

    expect(getConversationHandoffPending('conv-serial-1')).toBe(true);
    expect(ensureControlsSpy).not.toHaveBeenCalled();
    expect(touchSpy).not.toHaveBeenCalledWith('conv-serial-1', true);
    expect(screen.getByTestId('session-facts-probe')).toHaveAttribute(
      'data-agent-id',
      'codex'
    );

    resolveConfirm();

    await waitFor(() => {
      expect(getConversationHandoffPending('conv-serial-1')).toBe(false);
    });
    await waitFor(() => {
      expect(ensureControlsSpy).toHaveBeenCalledWith('conv-serial-1', {
        reload: false,
      });
    });
    await waitFor(() => {
      expect(touchSpy).toHaveBeenCalledWith('conv-serial-1', true);
    });
  });
});

