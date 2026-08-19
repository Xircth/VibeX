import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentManagementView } from 'shared/types';

import { PlanUsageDashboard } from './PlanUsageDashboard';

const mocks = vi.hoisted(() => ({
  planUsage: vi.fn(),
  runAction: vi.fn(),
  useAgentManagement: vi.fn(),
}));

vi.mock('@/features/agent-management', () => ({
  agentManagementApi: {
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
  enabled = true
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
    authentication: 'not_required',
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
    mocks.runAction.mockReset();
    mocks.useAgentManagement.mockReset();
    mocks.planUsage.mockResolvedValue({
      type: 'UNAVAILABLE',
      reason: 'NOT_LOGGED_IN',
    });
    mocks.runAction.mockResolvedValue({});
  });

  it('shows only enabled plan-capable agents and loads the selected plan', async () => {
    mocks.useAgentManagement.mockReturnValue({
      loading: false,
      state: {
        agents: [
          agent('claude_code', 'Claude Code'),
          agent('codex', 'Codex', false),
          agent('grok', 'Grok'),
          agent('gemini', 'Gemini'),
          agent('cursor', 'Cursor', false),
        ],
      },
    });

    renderDashboard();

    expect(screen.getByRole('button', { name: 'Claude Code' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Grok' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Codex' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cursor' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Gemini' })).toBeNull();

    expect(screen.getByText('Claude Code 套餐')).toBeVisible();
    expect(screen.queryByText('Grok 套餐')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Grok' }));

    expect(screen.getByText('Grok 套餐')).toBeVisible();
    expect(screen.queryByText('Claude Code 套餐')).toBeNull();

    await waitFor(() => {
      expect(mocks.planUsage).toHaveBeenCalledWith('grok');
    });
  });

  it('hides the selector when no enabled plan-capable agent exists', () => {
    mocks.useAgentManagement.mockReturnValue({
      loading: false,
      state: {
        agents: [agent('codex', 'Codex', false), agent('gemini', 'Gemini')],
      },
    });

    renderDashboard();

    expect(screen.getByText('没有已启用且支持套餐用量的 Agent')).toBeVisible();
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
