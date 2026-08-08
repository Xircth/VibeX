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

vi.mock('@/features/agent-management/api', () => ({
  agentManagementApi: {
    planUsage: vi.fn().mockResolvedValue({
      type: 'UNAVAILABLE',
      reason: 'NOT_LOGGED_IN',
    }),
  },
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

    expect(screen.getByText('Claude Code 套餐')).toBeVisible();
    expect(screen.getByText('Codex 套餐')).toBeVisible();
  });
});
