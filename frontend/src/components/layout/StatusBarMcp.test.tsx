import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginMcpStatusReport } from '@/lib/api/plugins';
import { HOST_MULTI_AGENT_ID } from '@/lib/api/plugins';

const mcpStatus = vi.fn<() => Promise<PluginMcpStatusReport>>();
const setEnabled = vi.fn<(id: string, enabled: boolean) => Promise<unknown>>();
const scanLocal = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const uninstallLocal = vi.hoisted(() =>
  vi.fn<(id: string) => Promise<unknown[]>>()
);
const updateAndSaveConfig = vi.hoisted(() =>
  vi.fn<(updates: { multi_agent_enabled: boolean }) => Promise<boolean>>()
);

vi.mock('@/lib/api', () => ({
  mcpMarketApi: {
    scanLocal: () => scanLocal(),
    uninstall: (id: string) => uninstallLocal(id),
  },
}));

vi.mock('@/lib/api/plugins', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/api/plugins')>(
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

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    config: { multi_agent_enabled: true },
    updateAndSaveConfig: (updates: { multi_agent_enabled: boolean }) =>
      updateAndSaveConfig(updates),
  }),
}));

const openSettingsSurface = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/settingsWindow', () => ({
  openSettingsSurface: (...args: unknown[]) => openSettingsSurface(...args),
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
    scanLocal.mockReset();
    uninstallLocal.mockReset();
    updateAndSaveConfig.mockReset();
    openSettingsSurface.mockReset();
    mcpStatus.mockResolvedValue(report());
    setEnabled.mockResolvedValue({});
    scanLocal.mockResolvedValue([]);
    uninstallLocal.mockResolvedValue([]);
    updateAndSaveConfig.mockResolvedValue(true);
  });

  it('keeps the trigger quiet and names the service in its accessible label', async () => {
    mount();
    const trigger = await screen.findByRole('button', { name: /MCP 服务/ });
    expect(trigger).toHaveTextContent('');
    expect(trigger.className).not.toMatch(/text-(success|destructive|warning)/);
  });

  it('lists declared browser tools without waiting for an agent', async () => {
    mcpStatus.mockResolvedValue(
      report({
        plugins: [
          {
            pluginId: 'vibex.browser',
            name: 'Browser',
            description: 'Built-in browser tabs.',
            enabled: true,
            enableSupported: true,
            mcpCount: 1,
            connection: 'running',
            servers: [
              {
                id: 'vibex-browser',
                product: null,
                tools: [
                  { name: 'browser_list_tabs', group: 'browser' },
                  { name: 'browser_snapshot', group: 'browser' },
                ],
              },
            ],
          },
        ],
      })
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /MCP 服务/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Browser' }));
    expect(await screen.findByText('列出标签页')).toBeInTheDocument();
    expect(screen.getByText('browser_list_tabs')).toBeInTheDocument();
    expect(
      screen.queryByText('Agent 连接后才会列出工具。')
    ).not.toBeInTheDocument();
  });

  it('lists plugins with MCP counts and expands to tools', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /MCP 服务/ }));

    expect(await screen.findByText('多智能体协同')).toBeInTheDocument();
    expect(screen.getByText(/1 个 MCP/)).toBeInTheDocument();
    expect(
      screen.getByTestId('mcp-plugin-status-vibex.multi-agent')
    ).toHaveTextContent('运行中');
    expect(
      screen.queryByRole('status', { name: /运行中/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('delegate_to_agent')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '多智能体协同' }));
    expect(await screen.findByText('委派给其他 Agent')).toBeInTheDocument();
    expect(screen.getByText('delegate_to_agent')).toBeInTheDocument();
    expect(
      screen.queryByText('把任务交给另一个 Agent。')
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看描述' }));
    expect(
      await screen.findByText('把任务交给另一个 Agent。')
    ).toBeInTheDocument();
  });

  it('does not show the global MCP hint', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /MCP 服务/ }));
    expect(
      screen.queryByText(
        '从这里启动的 Agent 可以使用已启用插件提供的 MCP 工具。'
      )
    ).not.toBeInTheDocument();
  });

  it('toggles the plugin MCP service', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /MCP 服务/ }));
    fireEvent.click(
      await screen.findByRole('switch', { name: '多智能体协同' })
    );

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

  it('shows an independent status light for each plugin', async () => {
    mcpStatus.mockResolvedValue(
      report({
        plugins: [
          report().plugins[0],
          {
            ...report().plugins[0],
            pluginId: 'vibex.session-enhance',
            name: '会话增强',
            enabled: false,
            connection: 'disabled',
          },
        ],
      })
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /MCP 服务/ }));
    expect(
      await screen.findByTestId('mcp-plugin-status-vibex.multi-agent')
    ).toHaveTextContent('运行中');
    expect(
      screen.getByTestId('mcp-plugin-status-vibex.session-enhance')
    ).toHaveTextContent('已停止');
  });

  it('lists the host collaboration-space MCP and toggles the host setting', async () => {
    mcpStatus.mockResolvedValue(
      report({
        plugins: [
          {
            pluginId: HOST_MULTI_AGENT_ID,
            name: 'host.multi-agent',
            description: 'internal',
            enabled: true,
            enableSupported: true,
            mcpCount: 1,
            connection: 'running',
            servers: [
              {
                id: 'vibex-delegation-mcp',
                product: 'delegation',
                tools: [
                  { name: 'post_space_message', group: 'collaboration' },
                  { name: 'delegate_to_agent', group: 'delegation' },
                ],
              },
            ],
          },
        ],
      })
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /MCP 服务/ }));
    expect(await screen.findByText('协作空间')).toBeInTheDocument();
    expect(
      screen.getByTestId(`mcp-plugin-status-${HOST_MULTI_AGENT_ID}`)
    ).toHaveTextContent('运行中');

    fireEvent.click(screen.getByRole('button', { name: '协作空间' }));
    expect(await screen.findByText('投递空间消息')).toBeInTheDocument();
    expect(screen.getByText('post_space_message')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-plugin-tools')).toHaveClass(
      'max-h-64',
      'overflow-y-auto'
    );

    fireEvent.click(screen.getByRole('switch', { name: '协作空间' }));
    await waitFor(() =>
      expect(updateAndSaveConfig).toHaveBeenCalledWith({
        multi_agent_enabled: false,
      })
    );
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('opens plugins in the dedicated settings window', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /MCP 服务/ }));
    fireEvent.click(await screen.findByRole('button', { name: /打开插件/ }));
    expect(openSettingsSurface).toHaveBeenCalledWith(
      expect.any(Function),
      '/plugins'
    );
  });

  it('displays connected local MCP servers such as GitHub and allows disconnecting', async () => {
    scanLocal.mockResolvedValue([
      {
        id: 'github',
        spec: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
        global: true,
        apps: ['claude_code', 'codex'],
      },
      {
        id: 'vibex-delegation-mcp',
        spec: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
        global: true,
        apps: [],
      },
    ]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /MCP 服务/ }));

    expect(await screen.findByText('GitHub')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-local-status-github')).toHaveTextContent(
      '运行中'
    );

    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }));
    expect(
      await screen.findByText('npx -y @modelcontextprotocol/server-github')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'GitHub' }));
    await waitFor(() =>
      expect(uninstallLocal).toHaveBeenCalledWith('github')
    );
  });

  it('displays discovered tools and tool count for connected local MCP servers when tools are available', async () => {
    scanLocal.mockResolvedValue([
      {
        id: 'github',
        spec: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
        global: true,
        apps: ['claude_code', 'codex'],
        tools: ['search_repositories', 'create_pull_request'],
      },
    ]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /MCP 服务/ }));

    expect(await screen.findByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('2 个工具')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }));
    const toolsList = await screen.findByTestId('mcp-plugin-tools');
    expect(toolsList).toHaveTextContent('search_repositories');
    expect(toolsList).toHaveTextContent('create_pull_request');
    expect(
      screen.queryByText('npx -y @modelcontextprotocol/server-github')
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '管理连接器配置' })
    ).toBeInTheDocument();
  });
});
