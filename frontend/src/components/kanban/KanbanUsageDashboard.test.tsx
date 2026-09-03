import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { localUsageApi } from '@/lib/api';
import { KanbanUsageDashboard } from './KanbanUsageDashboard';

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => ({ projectId: 'project-1' }),
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    projects: [{ id: 'project-1', name: 'VibeX' }],
  }),
}));

vi.mock('@/lib/api', () => ({
  localUsageApi: {
    getProjectStatistics: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('@/features/agent-management', () => ({
  agentManagementApi: {
    authMode: vi.fn().mockImplementation(async (agentId: string) => ({
      agent_id: agentId,
      mode:
        agentId === 'codex' ? 'chatgpt_subscription' : 'official_subscription',
      modes: [
        agentId === 'codex' ? 'chatgpt_subscription' : 'official_subscription',
      ],
      options: [],
      credential_env: '',
      credential_present: true,
    })),
    planUsage: vi.fn().mockResolvedValue({
      type: 'UNAVAILABLE',
      reason: 'NOT_LOGGED_IN',
    }),
    runAction: vi.fn().mockResolvedValue({}),
  },
  agentManagementErrorMessage: (_error: unknown, fallback: string) => fallback,
  useAgentManagement: () => ({
    loading: false,
    state: {
      agents: [
        {
          agent_id: 'claude_code',
          display_name: 'Claude Code',
          description: 'Claude',
          icon_light: null,
          icon_dark: null,
          icon_svg: null,
          source: 'built_in_profile',
          built_in: true,
          retired: false,
          enabled: true,
          position: 0,
          lifecycle: 'ready',
          authentication: 'account',
          runtime_version: '1.0.0',
          acp_version: '1.0.0',
          active_operation: null,
          rollback_available: false,
        },
        {
          agent_id: 'codex',
          display_name: 'Codex',
          description: 'Codex',
          icon_light: null,
          icon_dark: null,
          icon_svg: null,
          source: 'built_in_profile',
          built_in: true,
          retired: false,
          enabled: true,
          position: 1,
          lifecycle: 'ready',
          authentication: 'account',
          runtime_version: '1.0.0',
          acp_version: '1.0.0',
          active_operation: null,
          rollback_available: false,
        },
      ],
    },
  }),
}));

describe('KanbanUsageDashboard', () => {
  beforeEach(() => {
    vi.mocked(localUsageApi.getProjectStatistics).mockResolvedValue(
      null as never
    );
  });

  it('keeps plan usage available in the left navigation', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <KanbanUsageDashboard />
      </QueryClientProvider>
    );

    const planButton = screen.getByRole('button', { name: '套餐' });

    expect(planButton).toBeVisible();
    fireEvent.click(planButton);

    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('shows cache efficiency and daily token breakdowns in overview', async () => {
    vi.mocked(localUsageApi.getProjectStatistics).mockResolvedValue({
      scope: 'project',
      project_id: 'project-1',
      project_name: 'VibeX',
      total_sessions: 2,
      total_usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_write_tokens: 20,
        cache_read_tokens: 80,
        total_tokens: 250,
      },
      estimated_cost: 0.42,
      sessions: [
        {
          session_id: 'session-1',
          timestamp: new Date(2026, 8, 1, 15).getTime(),
          model: 'claude-sonnet-4',
          usage: {
            input_tokens: 80,
            output_tokens: 20,
            cache_write_tokens: 10,
            cache_read_tokens: 40,
            total_tokens: 150,
          },
          cost: 0.3,
          summary: 'First session',
          provider: 'claude',
        },
        {
          session_id: 'session-2',
          timestamp: new Date(2026, 8, 2, 9).getTime(),
          model: 'claude-sonnet-4',
          usage: {
            input_tokens: 20,
            output_tokens: 30,
            cache_write_tokens: 10,
            cache_read_tokens: 40,
            total_tokens: 100,
          },
          cost: 0.12,
          summary: 'Second session',
          provider: 'claude',
        },
      ],
      daily_usage: [
        {
          date: '2026-09-01',
          sessions: 1,
          usage: {
            input_tokens: 80,
            output_tokens: 20,
            cache_write_tokens: 10,
            cache_read_tokens: 40,
            total_tokens: 150,
          },
          cost: 0.3,
          models_used: ['claude-sonnet-4'],
        },
        {
          date: '2026-09-02',
          sessions: 1,
          usage: {
            input_tokens: 20,
            output_tokens: 30,
            cache_write_tokens: 10,
            cache_read_tokens: 40,
            total_tokens: 100,
          },
          cost: 0.12,
          models_used: ['claude-sonnet-4'],
        },
      ],
      weekly_comparison: {
        current_week: { sessions: 2, cost: 0.42, tokens: 250 },
        last_week: { sessions: 1, cost: 0.2, tokens: 100 },
        trends: { sessions: 100, cost: 110, tokens: 150 },
      },
      by_model: [
        {
          model: 'claude-sonnet-4',
          total_cost: 0.42,
          total_tokens: 250,
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_tokens: 20,
          cache_read_tokens: 80,
          session_count: 2,
        },
      ],
      provider_status: [],
      last_updated: Date.now(),
      pricing_notice: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <KanbanUsageDashboard />
      </QueryClientProvider>
    );

    expect(
      await screen.findByRole('img', { name: '缓存命中率: 40%' })
    ).toBeVisible();

    const dailyBar = screen.getByRole('button', {
      name: '09-02，共 100 Token',
    });
    fireEvent.mouseEnter(dailyBar);

    expect(screen.getByText('总计：100 Token')).toBeVisible();
    expect(screen.getByText('新鲜：60')).toBeVisible();
    expect(screen.getByText('缓存读取：40')).toBeVisible();

    const heatmapCell = screen.getByRole('img', {
      name: '二 15:00，150 Token',
    });
    fireEvent.mouseEnter(heatmapCell);

    expect(screen.getByRole('tooltip')).toHaveTextContent('二 15:00');
    expect(screen.getByRole('tooltip')).toHaveTextContent('150 Token');
  });
});
