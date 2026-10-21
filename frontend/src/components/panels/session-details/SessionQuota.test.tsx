import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { ThemeMode, type AgentManagementView } from 'shared/types';
import { SessionQuota } from './SessionQuota';

const mocks = vi.hoisted(() => ({
  authMode: vi.fn(),
  planUsage: vi.fn(),
  runAction: vi.fn(),
  useAgentManagement: vi.fn(),
}));

vi.mock('@/components/ThemeProvider', () => ({
  useTheme: () => ({
    theme: ThemeMode.LIGHT,
    resolvedTheme: 'light',
    setTheme: () => undefined,
  }),
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

function grokAgent(): AgentManagementView {
  return {
    agent_id: 'grok',
    display_name: 'Grok',
    description: 'Grok',
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
  };
}

describe('SessionQuota', () => {
  beforeEach(() => {
    mocks.authMode.mockReset();
    mocks.planUsage.mockReset();
    mocks.runAction.mockReset();
    mocks.useAgentManagement.mockReset();
    mocks.authMode.mockResolvedValue({ mode: 'subscription' });
    mocks.planUsage.mockResolvedValue({
      type: 'OK',
      usage: {
        planType: 'SuperGrok Heavy',
        windows: [],
        credits: null,
      },
    });
    mocks.useAgentManagement.mockReturnValue({
      loading: false,
      state: { agents: [grokAgent()] },
    });
  });

  it('names the signed-in agent on the plan card', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionQuota agentId="grok" />
      </QueryClientProvider>
    );

    expect(
      await screen.findByRole('img', { name: 'Grok' })
    ).toBeInTheDocument();
    expect(screen.getByText('Grok')).toBeInTheDocument();
    expect(await screen.findByText('SuperGrok Heavy')).toBeInTheDocument();
  });
});
