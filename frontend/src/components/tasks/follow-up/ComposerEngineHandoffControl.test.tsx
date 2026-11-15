import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbConversationDetail, ExecutorProfileId } from 'shared/types';
import { sessionListAgentKey } from '@/components/kanban/session-hub/utils';
import { conversationApi } from '@/features/conversation/conversationApi';
import {
  useConversationSessionFacts,
  useConversationTimeline,
} from '@/features/conversation/useConversationTimeline';
import type { SessionSummary as SessionSummaryRecord } from '@/lib/api';
import { providerInstancesApi } from '@/lib/providerInstancesApi';
import {
  ComposerEngineHandoffModal,
  ComposerProviderInstanceSlot,
  useComposerEngineHandoff,
} from './ComposerEngineHandoffControl';

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
  hasExistingTurns,
  currentExecutor,
  onApply,
}: {
  sessionId: string | null;
  hasExistingTurns: boolean;
  currentExecutor: string;
  onApply: (profile: ExecutorProfileId | null) => void;
}) {
  const controller = useComposerEngineHandoff({
    sessionId,
    hasExistingTurns,
    currentExecutor,
    onApplyExecutorProfile: onApply,
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
      <SessionFactsProbe sessionId={sessionId} />
      <ComposerEngineHandoffModal controller={controller} />
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
            options: [],
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
    while (spies.length > 0) {
      spies.pop()?.mockRestore();
    }
  });

  it('mounts ProviderInstanceSelector for matching agent instances in composer', async () => {
    trackSpy(
      vi.spyOn(providerInstancesApi, 'list').mockResolvedValue([
        {
          instanceId: 'claude-work',
          agentId: 'claude-code',
          displayName: 'Work OAuth',
          authMode: { mode: 'OfficialOAuth' },
          isDefault: true,
          hasActiveSessions: false,
        },
        {
          instanceId: 'claude-personal',
          agentId: 'claude-code',
          displayName: 'Personal Key',
          authMode: { mode: 'ApiKey' },
          isDefault: false,
          hasActiveSessions: false,
        },
        {
          instanceId: 'codex-pro',
          agentId: 'codex',
          displayName: 'Codex Pro',
          authMode: { mode: 'OfficialOAuth' },
          isDefault: true,
          hasActiveSessions: false,
        },
      ])
    );

    render(<ComposerProviderInstanceSlot agentId="CLAUDE_CODE" />);

    const select = (await screen.findByTestId(
      'provider-instance-select'
    )) as HTMLSelectElement;
    expect(select.options).toHaveLength(2);
    expect(select.value).toBe('claude-work');

    fireEvent.change(select, { target: { value: 'claude-personal' } });
    expect(select.value).toBe('claude-personal');
  });

  it('previews and confirms EngineHandoffDialog when switching engines on a session with turns and syncs session list + Bot/Session details', async () => {
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
      vi.spyOn(conversationApi, 'previewEngineHandoff').mockResolvedValue({
        sourceEngine: 'Claude Code',
        targetEngine: 'Codex',
        totalTokens: 8400,
        tokenBudget: 40000,
        packedMessages: [
          {
            id: 'turn-1',
            role: 'user',
            content: 'Audit the authentication flow',
            sortIndex: 1,
          },
          {
            id: 'turn-2',
            role: 'assistant',
            content: 'Reviewed token validation and session middleware.',
            sortIndex: 2,
          },
        ],
        omittedIds: ['turn-0'],
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
          sessionId="conv-active-1"
          hasExistingTurns
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

    const dialog = await screen.findByTestId('engine-handoff-dialog');
    expect(previewSpy).toHaveBeenCalledWith({
      conversationId: 'conv-active-1',
      targetEngine: 'CODEX',
    });
    expect(dialog).toHaveTextContent('Claude Code');
    expect(dialog).toHaveTextContent('Codex');
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('handoff-confirm-btn'));

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
          hasExistingTurns={false}
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
});
