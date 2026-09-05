import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentManagementView } from 'shared/types';

import { PlanUsageDashboard } from './PlanUsageDashboard';

const mocks = vi.hoisted(() => ({
  authMode: vi.fn(),
  planUsage: vi.fn(),
  runAction: vi.fn(),
  useAgentManagement: vi.fn(),
}));

vi.mock('@/features/agent-management', () => ({
  agentManagementApi: {
    authMode: mocks.authMode,
    planUsage: mocks.planUsage,
    runAction: mocks.runAction,
  },
  agentManagementErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
  useAgentManagement: mocks.useAgentManagement,
}));

function agent(
  agentId: string,
  displayName: string,
  enabled = true,
  authentication: AgentManagementView['authentication'] = 'not_required'
): AgentManagementView {
  return {
    agent_id: agentId,
    display_name: displayName,
    description: `${displayName} description`,
    icon_light: null,
    icon_dark: null,
    icon_svg: null,
    source: 'built_in_profile',
    built_in: true,
    retired: false,
    enabled,
    position: 0,
    lifecycle: 'ready',
    authentication,
    runtime_version: '1.0.0',
    acp_version: '1.0.0',
    active_operation: null,
    rollback_available: false,
  };
}

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PlanUsageDashboard />
    </QueryClientProvider>
  );
}

describe('PlanUsageDashboard', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.planUsage.mockReset();
    mocks.authMode.mockReset();
    mocks.runAction.mockReset();
    mocks.useAgentManagement.mockReset();
    mocks.planUsage.mockResolvedValue({
      type: 'UNAVAILABLE',
      reason: 'NOT_LOGGED_IN',
    });
    mocks.authMode.mockImplementation(async (agentId: string) => ({
      agent_id: agentId,
      mode:
        agentId === 'grok'
          ? 'subscription'
          : agentId === 'codex'
            ? 'chatgpt_subscription'
            : 'official_subscription',
      modes: [
        agentId === 'grok'
          ? 'subscription'
          : agentId === 'codex'
            ? 'chatgpt_subscription'
            : 'official_subscription',
        'official_api',
      ],
      options: [
        {
          value:
            agentId === 'grok'
              ? 'subscription'
              : agentId === 'codex'
                ? 'chatgpt_subscription'
                : 'official_subscription',
          kind: 'subscription',
          label_key: 'subscription',
          description_key: 'subscription',
          credential_env: null,
          native_config_field_id: null,
          credential_required: false,
        },
        {
          value: 'api_key',
          kind: 'official_api',
          label_key: 'api_key',
          description_key: 'api_key',
          credential_env: null,
          native_config_field_id: null,
          credential_required: true,
        },
      ],
      credential_env: '',
      credential_present: true,
    }));
    mocks.runAction.mockResolvedValue({});
  });

  it('shows the settings surface skeleton while agent list is loading', () => {
    mocks.useAgentManagement.mockReturnValue({
      loading: true,
      state: { agents: [] },
    });

    renderDashboard();

    const status = screen.getByRole('status');
    expect(status).toHaveClass('agent-settings-loading');
    expect(status.querySelectorAll('.settings-surface')).toHaveLength(2);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('renders every enabled signed-in subscription agent as its own card', async () => {
    mocks.useAgentManagement.mockReturnValue({
      loading: false,
      state: {
        agents: [
          agent('claude_code', 'Claude Code', true, 'account'),
          agent('codex', 'Codex', false),
          agent('grok', 'Grok', true, 'account'),
          agent('gemini', 'Gemini'),
          agent('cursor', 'Cursor', false),
        ],
      },
    });

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Claude Code 套餐')).toBeVisible();
      expect(screen.getByText('Grok 套餐')).toBeVisible();
      expect(mocks.authMode).toHaveBeenCalledWith('claude_code');
      expect(mocks.authMode).toHaveBeenCalledWith('grok');
      expect(mocks.planUsage).toHaveBeenCalledWith('grok');
      expect(mocks.planUsage).toHaveBeenCalledWith('claude_code');
    });
  });

  it('does not render agents that are not signed in to an official subscription', async () => {
    mocks.useAgentManagement.mockReturnValue({
      loading: false,
      state: { agents: [agent('claude_code', 'Claude Code', true, 'api_key')] },
    });

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('没有已登录的官方订阅 Agent')).toBeVisible();
    });
    expect(mocks.planUsage).not.toHaveBeenCalled();
  });

  it('hides the selector when no enabled plan-capable agent exists', () => {
    mocks.useAgentManagement.mockReturnValue({
      loading: false,
      state: {
        agents: [agent('codex', 'Codex', false), agent('gemini', 'Gemini')],
      },
    });

    renderDashboard();

    expect(screen.getByText('没有已登录的官方订阅 Agent')).toBeVisible();
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
