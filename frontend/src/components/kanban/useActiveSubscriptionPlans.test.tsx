import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentManagementView } from 'shared/types';
import { agentManagementApi } from '@/features/agent-management';
import { useActiveSubscriptionPlans } from './useActiveSubscriptionPlans';

vi.mock('@/features/agent-management', () => ({
  agentManagementApi: {
    authMode: vi.fn(),
    planUsage: vi.fn(),
  },
}));

function makeAgent(
  overrides: Partial<AgentManagementView> &
    Pick<AgentManagementView, 'agent_id' | 'display_name'>
): AgentManagementView {
  return {
    description: '',
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
    ...overrides,
  };
}

describe('useActiveSubscriptionPlans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('probes plan usage only for signed-in official subscriptions and maps by agent_id', async () => {
    vi.mocked(agentManagementApi.authMode).mockImplementation(
      async (agentId: string) => {
        if (agentId === 'claude_code') {
          return {
            agent_id: 'claude_code',
            mode: 'official_subscription',
            modes: ['official_subscription', 'api_key'],
            options: [],
            credential_env: '',
            credential_present: true,
          };
        }
        if (agentId === 'antigravity') {
          return {
            agent_id: 'antigravity',
            mode: 'oauth-personal',
            modes: ['oauth-personal'],
            options: [],
            credential_env: '',
            credential_present: true,
          };
        }
        return {
          agent_id: agentId,
          mode: 'api_key',
          modes: ['api_key'],
          options: [],
          credential_env: '',
          credential_present: true,
        };
      }
    );

    vi.mocked(agentManagementApi.planUsage).mockImplementation(
      async (agentId: string) => {
        if (agentId === 'claude_code') {
          return {
            type: 'OK',
            usage: {
              planType: 'pro',
              windows: [
                {
                  id: 'five_hour',
                  usedPercent: 25,
                  windowMinutes: 300,
                  resetsAtMs: null,
                },
              ],
              credits: null,
            },
          };
        }
        return {
          type: 'UNAVAILABLE',
          reason: 'NOT_LOGGED_IN',
        } as never;
      }
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const agents = [
      makeAgent({ agent_id: 'claude_code', display_name: 'Claude Code' }),
      makeAgent({ agent_id: 'antigravity', display_name: 'Antigravity' }),
      makeAgent({
        agent_id: 'codex',
        display_name: 'Codex',
        authentication: 'api_key',
      }),
      makeAgent({
        agent_id: 'opencode',
        display_name: 'OpenCode',
        lifecycle: 'uninstalled',
      }),
    ];

    const { result } = renderHook(() => useActiveSubscriptionPlans(agents), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.activeSubscriptionPlans).toHaveLength(1);
    });

    expect(agentManagementApi.authMode).toHaveBeenCalledTimes(2);
    expect(agentManagementApi.planUsage).toHaveBeenCalledWith('claude_code');
    expect(agentManagementApi.planUsage).toHaveBeenCalledWith('antigravity');
    expect(result.current.planUsagesByAgentId).toEqual({
      claude_code: {
        planType: 'pro',
        windows: [
          {
            id: 'five_hour',
            usedPercent: 25,
            windowMinutes: 300,
            resetsAtMs: null,
          },
        ],
        credits: null,
      },
    });
  });
});
