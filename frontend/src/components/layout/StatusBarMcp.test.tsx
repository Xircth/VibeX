import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginMcpStatusReport } from '@/lib/api/plugins';

const mcpStatus = vi.fn<() => Promise<PluginMcpStatusReport>>();
const setEnabled = vi.fn<(id: string, enabled: boolean) => Promise<unknown>>();

vi.mock('@/lib/api/plugins', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/plugins')>(
    '@/lib/api/plugins'
  );
  return {
    ...actual,
    createPluginControlApi: () => ({
      mcpStatus: () => mcpStatus(),
      setEnabled: (id: string, enabled: boolean) => setEnabled(id, enabled),
      ensureMcpRunning: () => Promise.resolve({ listening: true }),
    }),
  };
});

vi.mock('@/lib/transport', () => ({
  useBackendTransport: () => ({}),
}));

import { StatusBarMcp } from './StatusBarMcp';

function report(
  overrides: Partial<PluginMcpStatusReport> = {}
): PluginMcpStatusReport {
  return {
    state: 'running',
    listening: true,
    plugins: [
      {
        pluginId: 'vibex.multi-agent',
        name: '多智能体协同',
        description: '把任务交给另一个 Agent。',
        enabled: true,
        enableSupported: true,
        mcpCount: 1,
        connection: 'running',
        servers: [
          {
            id: 'vibex-delegation-mcp',
            product: 'delegation',
            tools: [
              { name: 'delegate_to_agent', group: 'delegation' },
              { name: 'get_delegation_status', group: 'delegation' },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StatusBarMcp />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('StatusBarMcp', () => {
  beforeEach(() => {
    mcpStatus.mockReset();
    setEnabled.mockReset();
    mcpStatus.mockResolvedValue(report());
    setEnabled.mockResolvedValue({});
  });

  it('keeps the trigger quiet and names the service in its accessible label', async () => {
    mount();
    const trigger = await screen.findByRole('button', { name: /MCP 服务/ });
    expect(trigger).toHaveTextContent('');
    expect(trigger.className).not.toMatch(/text-(success|destructive|warning)/);
  });

  it('lists plugins with MCP counts and expands to tools', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /MCP 服务/ }));

    expect(await screen.findByText('多智能体协同')).toBeInTheDocument();
    expect(screen.getByText(/1 个 MCP/)).toBeInTheDocument();
    expect(screen.queryByText('delegate_to_agent')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '多智能体协同' }));
    expect(await screen.findByText('委派给其他 Agent')).toBeInTheDocument();
    expect(screen.getByText('delegate_to_agent')).toBeInTheDocument();
  });

  it('toggles the plugin MCP service', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /MCP 服务/ }));
    fireEvent.click(await screen.findByRole('switch', { name: '多智能体协同' }));

    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith('vibex.multi-agent', false)
    );
  });

  it('does not offer a switch when enable is unsupported', async () => {
    mcpStatus.mockResolvedValue(
      report({
        plugins: [
          {
            ...report().plugins[0],
            enableSupported: false,
          },
        ],
      })
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /MCP 服务/ }));
    expect(
      await screen.findByRole('switch', { name: '多智能体协同' })
    ).toBeDisabled();
  });
});
