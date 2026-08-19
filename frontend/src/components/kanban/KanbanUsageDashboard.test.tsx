import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
          authentication: 'not_required',
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
          authentication: 'not_required',
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

    expect(screen.getByRole('button', { name: 'Claude Code' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Codex' })).toBeVisible();
    expect(screen.getByText('Claude Code 套餐')).toBeVisible();
    expect(screen.queryByText('Codex 套餐')).toBeNull();
  });
});
