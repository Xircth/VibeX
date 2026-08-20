import { open } from '@tauri-apps/plugin-dialog';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import type {
  PluginContributionCatalog,
  PluginControlCatalog,
} from '@/lib/api/plugins';
import { toast } from '@/components/ui/toast';
import { PluginsSettings, type PluginEcosystem } from './PluginsSettings';

vi.mock('@/components/ui/toast', () => ({
  toast: {
    error: vi.fn(),
  },
}));

const catalog: PluginControlCatalog = {
  plugins: [
    {
      id: 'vibex.office',
      name: 'VibeX Office',
      version: '2.0.0',
      description: 'Create and edit office artifacts.',
      enabled: true,
      builtin: true,
      publisher: 'VibeX',
      packageDigest: 'sha256:office-package',
      sourceKind: 'builtin',
      sourcePath: '/Applications/VibeX/assets/plugins/office',
      formats: ['vibex'],
      skills: [
        { id: 'office-pptx', path: 'skills/office-pptx/SKILL.md' },
        { id: 'office-docx', path: 'skills/office-docx/SKILL.md' },
        { id: 'office-xlsx', path: 'skills/office-xlsx/SKILL.md' },
      ],
      runtimes: [
        {
          id: 'officecli',
          command: 'officecli',
          version: '1.0.140',
          target: 'aarch64-apple-darwin',
          contentDigest: 'sha256:officecli-1.0.140',
          installer: 'existing',
        },
      ],
      warnings: [],
      mcpCount: 0,
      invocationCount: 6,
      appContributions: [
        {
          id: 'office.preview',
          kind: 'file_opener',
          label: 'Office preview',
          metadata: { extensions: ['docx', 'pptx', 'xlsx'] },
        },
        {
          id: 'office-preview',
          kind: 'preview_provider',
          label: 'Office document preview',
          metadata: { runtime: 'officecli' },
        },
      ],
    },
    {
      id: 'dev.vibex.research',
      name: 'Research Toolkit',
      version: '1.4.0',
      description: 'Shared research workflow.',
      enabled: false,
      builtin: false,
      publisher: 'Acme Research',
      packageDigest: 'sha256:research-1.4.0',
      sourceKind: 'developer_link',
      sourcePath: '/Users/me/plugins/research',
      formats: ['vibex', 'codex', 'claude_code'],
      skills: [
        { id: 'research', path: 'skills/research/SKILL.md' },
        { id: 'citations', path: 'skills/citations/SKILL.md' },
      ],
      runtimes: [
        {
          id: 'research-cli',
          command: 'research',
          version: '1.4.0',
          target: 'aarch64-apple-darwin',
          contentDigest: 'sha256:research-cli-1.4.0',
          installer: 'shell',
          installCommand: './install.sh',
        },
      ],
      warnings: [],
      permissions: [
        {
          id: 'run-research',
          capability: 'runtime.execute',
          scope: { runtime: 'research-cli', operations: ['inspect'] },
          reason: 'Run the locked research runtime.',
          optional: false,
        },
        {
          id: 'research-network',
          capability: 'network.fetch',
          scope: { hosts: ['api.example.test'] },
          reason: 'Fetch optional external references.',
          optional: true,
        },
      ],
      permissionDelta: [
        {
          id: 'research-export',
          capability: 'artifact.write',
          scope: { formats: ['md'] },
          reason: 'Export the final research report.',
          optional: false,
        },
      ],
      updatePackageDigest: 'sha256:research-1.5.0',
      updateSupported: true,
      rollbackSupported: true,
      mcpCount: 1,
      mcpServers: ['research-mcp'],
      invocationCount: 2,
      invocations: [
        {
          id: 'research.run',
          label: '开始研究',
          prompt: 'Run the research workflow.',
          kind: 'action',
        },
        {
          id: 'research.citations',
          label: '整理引用',
          prompt: 'Format the collected citations.',
          kind: 'command',
        },
      ],
    },
    {
      id: 'openai.browser',
      name: 'Browser Tools',
      version: '1.0.0',
      description: 'Codex browser workflows.',
      enabled: true,
      builtin: false,
      sourceKind: 'codex_native',
      sourcePath: '/Users/me/.codex/plugins/cache/browser',
      formats: ['codex'],
      skills: [{ id: 'browser', path: 'skills/browser/SKILL.md' }],
      runtimes: [
        {
          id: 'browser-runtime',
          command: 'browser-runtime',
          version: '1.0.0',
          installer: 'existing',
        },
      ],
      hooks: [{ id: 'session-start', path: 'hooks/session-start.json' }],
      workflows: [
        { id: 'browse-and-summarize', path: 'workflows/browse.json' },
      ],
      warnings: [],
      mcpCount: 0,
      invocationCount: 0,
      nativeManaged: true,
      enableSupported: false,
      updateSupported: false,
      uninstallSupported: true,
    },
    {
      id: 'anthropic.frontend',
      name: 'Frontend Design',
      version: '1.0.0',
      description: 'Claude Code frontend workflows.',
      enabled: true,
      builtin: false,
      sourceKind: 'claude_code_native',
      sourcePath: '/Users/me/.claude/plugins/cache/frontend-design',
      formats: ['claude_code'],
      skills: [{ id: 'frontend-design', path: 'skills/frontend/SKILL.md' }],
      runtimes: [],
      warnings: [],
      mcpCount: 0,
      invocationCount: 0,
      nativeManaged: true,
      enableSupported: true,
      updateSupported: true,
      uninstallSupported: true,
    },
  ],
  runtimes: [
    {
      id: 'officecli',
      version: '1.0.140',
      target: 'aarch64-apple-darwin',
      contentDigest: 'sha256:officecli-1.0.140',
      executablePath: '/managed/officecli/1.0.140/bin/officecli',
      ownership: 'managed',
      installer: 'archive',
      probe: ['officecli', '--version'],
      referencedPlugins: ['vibex.office'],
    },
    {
      id: 'officecli',
      version: '1.0.139',
      target: 'x86_64-apple-darwin',
      contentDigest: 'sha256:officecli-1.0.139',
      executablePath: '/managed/officecli/1.0.139/bin/officecli',
      ownership: 'external',
      installer: 'existing',
      probe: ['officecli', '--version'],
      referencedPlugins: [],
    },
  ],
};

const contributionDetails = {
  skills: [
    {
      id: 'research',
      path: 'skills/research/SKILL.md',
      content: '# Research workflow\n\nInvestigate primary sources.',
    },
    {
      id: 'citations',
      path: 'skills/citations/SKILL.md',
      content: '# Citation workflow\n\nAttach precise source links.',
    },
  ],
  mcpServers: [
    {
      id: 'research-mcp',
      config: {
        command: 'research-mcp',
        args: ['serve'],
      },
    },
  ],
};

const contributionCatalog: PluginContributionCatalog = {
  generation: 7,
  items: [
    {
      pluginId: 'vibex.office',
      id: 'office.preview',
      kind: 'file_opener',
      label: 'Office preview',
      generation: 7,
      metadata: { extensions: ['docx', 'pptx', 'xlsx'] },
    },
    {
      pluginId: 'vibex.office',
      id: 'office-preview',
      kind: 'preview_provider',
      label: 'Office document preview',
      generation: 7,
      metadata: { fileOpener: 'office.preview', runtime: 'officecli' },
    },
    {
      pluginId: 'vibex.office',
      id: 'office-pptx',
      kind: 'skill',
      label: 'Office presentation skill',
      generation: 7,
      metadata: { path: 'skills/office-pptx/SKILL.md' },
    },
    {
      pluginId: 'vibex.office',
      id: 'office-dashboard',
      kind: 'app_surface',
      label: 'Office dashboard',
      generation: 7,
      metadata: {
        slot: 'plugin.detail.panel',
        appEntrypoint: 'app',
        route: '/dashboard',
        handler: 'surface.createSession',
        allowedMethods: [],
        minHeight: 320,
      },
    },
  ],
};

function LocationProbe() {
  const location = useLocation();
  return (
    <output aria-label="Current location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function transport(overrides: Record<string, unknown> = {}) {
  const call = vi.fn(async (command: string, args?: unknown) => {
    if (command in overrides) {
      const value = overrides[command];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown)(args)
        : value;
    }
    if (command === 'plugin_control_catalog') return catalog;
    if (command === 'plugin_contribution_catalog') return contributionCatalog;
    if (command === 'plugin_dev_connection') {
      return {
        endpoint: 'http://127.0.0.1:43100',
        token: 'secret-dev-token',
        protocolVersion: '1.0',
      };
    }
    if (command === 'plugin_control_contributions') {
      return contributionDetails;
    }
    if (command === 'plugin_surface_open') {
      return {
        html: '<main><h1>Office dashboard</h1></main>',
        token: '0123456789abcdef0123456789abcdef',
      };
    }
    if (command === 'plugin_control_set_enabled') return catalog.plugins[1];
    if (command === 'plugin_control_grant_permissions') return [];
    if (command === 'plugin_control_update') return catalog.plugins[3];
    if (command === 'plugin_control_rollback') {
      return { ...catalog.plugins[1], version: '1.3.0' };
    }
    if (command === 'plugin_control_configure_agents') return [];
    throw new Error(`unexpected command: ${command}`);
  });
  const stream = vi.fn(
    async (
      command: string,
      args: Record<string, unknown>,
      onMessage: (message: unknown) => void
    ) => {
      if (command !== 'plugin_control_import_cli') {
        throw new Error(`unexpected stream command: ${command}`);
      }
      onMessage({ event: 'started', command: args.command });
      onMessage({
        event: 'log',
        stream: 'stdout',
        line: 'Installed frontend-design@official',
      });
      onMessage({ event: 'command_finished', success: true, exitCode: 0 });
      return {
        success: true,
        importedPluginIds: ['frontend-design@official'],
      };
    }
  );
  return {
    call,
    stream,
    value: {
      environment: 'desktop',
      call,
      stream,
      capabilities: async () => ({
        server_version: 'desktop',
        protocol_version: '1.0',
        minimum_client_version: '0.1.0',
        capabilities: ['plugin.read', 'plugin.write', 'plugin.surface'],
      }),
    } as BackendTransport,
  };
}

function renderSettings(
  backend: BackendTransport,
  showLocation = false,
  ecosystem?: PluginEcosystem,
  embedded = false
) {
  return render(
    <MemoryRouter initialEntries={['/settings/plugins']}>
      <PluginsSettings
        transport={backend}
        ecosystem={ecosystem}
        embedded={embedded}
      />
      {showLocation ? <LocationProbe /> : null}
    </MemoryRouter>
  );
}

describe('PluginsSettings', () => {
  beforeEach(() => {
    vi.mocked(open).mockReset();
    vi.mocked(toast.error).mockReset();
    localStorage.clear();
  });

  it('omits the repeated section header when embedded in Agent settings', async () => {
    const backend = transport();
    const view = renderSettings(backend.value, false, 'codex', true);

    expect(
      await screen.findByRole('searchbox', { name: '搜索 Codex 插件' })
    ).toBeVisible();
    expect(view.container.querySelector('.plugin-hub-shell')).toHaveClass(
      'is-embedded'
    );
    expect(view.container.querySelector('.settings-section')).toBeNull();
  });

  it('previews only Agent-native resources in Codex and Claude Code settings', async () => {
    const backend = transport();
    renderSettings(backend.value, false, 'codex', true);

    const detail = await screen.findByRole('region', { name: 'Browser Tools' });
    const headings = within(detail)
      .getAllByRole('heading', { level: 4 })
      .map((heading) => heading.textContent);

    expect(headings).toEqual([
      'Skills',
      'MCP',
      'Runtime',
      'Hooks',
      'Workflows',
    ]);
    expect(within(detail).getByText('browser')).toBeVisible();
    expect(within(detail).getByText('browser-runtime')).toBeVisible();
    expect(within(detail).getByText('session-start')).toBeVisible();
    expect(within(detail).getByText('browse-and-summarize')).toBeVisible();
    expect(within(detail).queryByText('扩展 VibeX')).not.toBeInTheDocument();
    expect(within(detail).queryByText('扩展 Agent')).not.toBeInTheDocument();
    expect(within(detail).queryByText('调用命令')).not.toBeInTheDocument();
    expect(within(detail).queryByText('来源')).not.toBeInTheDocument();
  });

  it('scopes the product module to VibeX plugins and reads the activation registry', async () => {
    const backend = transport();
    renderSettings(backend.value, false, 'vibex');

    expect((await screen.findAllByText('VibeX Office')).length).toBeGreaterThan(
      0
    );
    expect(screen.getAllByText('Research Toolkit').length).toBeGreaterThan(0);
    expect(screen.queryByText('Browser Tools')).not.toBeInTheDocument();
    expect(screen.queryByText('Frontend Design')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('tablist', { name: '插件生态' })
    ).not.toBeInTheDocument();
    expect(backend.call).toHaveBeenCalledWith('plugin_contribution_catalog');
    expect(await screen.findByText('扩展 VibeX')).toBeVisible();
    expect(screen.getByText('打开与预览文件')).toBeVisible();
    expect(screen.getByText('DOCX · PPTX · XLSX')).toBeVisible();
    expect(screen.queryByText('激活代次 7')).not.toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Office dashboard' })
    ).toBeVisible();
    expect(await screen.findByTitle('Office dashboard')).not.toHaveAttribute(
      'sandbox'
    );
    const surfaceOpenCount = backend.call.mock.calls.filter(
      ([command]) => command === 'plugin_surface_open'
    ).length;
    await userEvent.type(
      screen.getByRole('searchbox', { name: '搜索 VibeX 插件' }),
      'office'
    );
    expect(
      backend.call.mock.calls.filter(
        ([command]) => command === 'plugin_surface_open'
      )
    ).toHaveLength(surfaceOpenCount);
    expect(backend.call).not.toHaveBeenCalledWith(
      'plugin_surface_revoke',
      expect.anything()
    );
  });

  it('shows declared app extensions while a product plugin is disabled', async () => {
    const disabledCatalog: PluginControlCatalog = {
      ...catalog,
      plugins: catalog.plugins.map((plugin) =>
        plugin.id === 'vibex.office' ? { ...plugin, enabled: false } : plugin
      ),
    };
    const backend = transport({
      plugin_control_catalog: disabledCatalog,
      plugin_contribution_catalog: { generation: 7, items: [] },
    });

    renderSettings(backend.value, false, 'vibex');

    expect(await screen.findByText('打开与预览文件')).toBeVisible();
    expect(screen.getByText('DOCX · PPTX · XLSX')).toBeVisible();
    expect(
      screen.queryByText('此插件没有声明应用扩展。')
    ).not.toBeInTheDocument();
  });

  it('keeps Web plugin browsing and surfaces read-only without invoking local file UX', async () => {
    const user = userEvent.setup();
    const backend = transport();
    const webTransport: BackendTransport = {
      ...backend.value,
      environment: 'web',
      stream: undefined,
      capabilities: async () => ({
        server_version: 'remote',
        protocol_version: '1.0',
        minimum_client_version: '0.1.0',
        capabilities: ['plugin.read', 'plugin.surface'],
      }),
    };
    renderSettings(webTransport, false, 'vibex');

    expect(await screen.findByTitle('Office dashboard')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: '导入插件' })
    ).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );
    expect(
      screen.getByRole('switch', { name: '启用 Research Toolkit' })
    ).toBeDisabled();
    expect(screen.getByText('远程只读')).toBeVisible();
    expect(open).not.toHaveBeenCalled();
    expect(backend.call).not.toHaveBeenCalledWith('plugin_dev_connection');
  });

  it('allows remote writes by capability while keeping local ZIP import desktop-only', async () => {
    const backend = transport();
    const remoteTransport: BackendTransport = {
      ...backend.value,
      environment: 'remote-desktop',
      stream: undefined,
      capabilities: async () => ({
        server_version: 'remote',
        protocol_version: '1.0',
        minimum_client_version: '0.1.0',
        capabilities: ['plugin.read', 'plugin.write', 'plugin.surface'],
      }),
    };
    renderSettings(remoteTransport, false, 'vibex');
    await screen.findByText('Research Toolkit');

    expect(
      screen.queryByRole('button', { name: '导入插件' })
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /VibeX Office/ })).toBeEnabled()
    );
  });

  it('opens plugin development without copying a CLI connection', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value, false, 'vibex');

    await user.click(await screen.findByRole('button', { name: '插件开发' }));
    const dialog = await screen.findByRole('dialog', { name: '插件开发' });
    expect(within(dialog).getByText(/普通使用插件不需要它/)).toBeVisible();
    expect(
      within(dialog).getByRole('link', { name: '开发文档' })
    ).toHaveAttribute('href', 'https://vibex.xforver.xin/docs/developers');
    expect(
      within(dialog).getByRole('button', { name: '启用插件开发' })
    ).toBeVisible();
    expect(
      within(dialog).queryByRole('button', { name: '复制 CLI 连接' })
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText(/vibex-plugin dev、install --link/)
    ).not.toBeInTheDocument();
    expect(screen.queryByText('secret-dev-token')).not.toBeInTheDocument();
  });

  it('separates native ecosystems into tabs and searches only the active tab', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value);

    expect(await screen.findByRole('heading', { name: '插件' })).toBeVisible();
    expect(
      screen.getByText('在此管理 Codex、ClaudeCode 以及 VibeX 平台支持的插件')
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: '插件控制面' })
    ).not.toBeInTheDocument();

    const tabs = await screen.findByRole('tablist', { name: '插件生态' });
    const headerActions = tabs.closest('.plugin-hub-header-actions');
    expect(headerActions).not.toBeNull();
    expect(headerActions).toContainElement(
      screen.getByRole('button', { name: '导入插件' })
    );
    const codexTab = within(tabs).getByRole('tab', { name: 'Codex' });
    expect(codexTab).toHaveAttribute('aria-selected', 'true');
    expect(within(codexTab).getByTitle('Codex')).toBeInTheDocument();
    expect(
      within(within(tabs).getByRole('tab', { name: 'Claude Code' })).getByTitle(
        'Claude Code'
      )
    ).toBeInTheDocument();
    expect(screen.getAllByText('Browser Tools').length).toBeGreaterThan(0);
    const browserRow = screen.getByRole('button', { name: /Browser Tools/ });
    expect(within(browserRow).queryByText('Codex')).not.toBeInTheDocument();
    expect(screen.queryByText('VibeX Office')).not.toBeInTheDocument();
    expect(screen.queryByText('Frontend Design')).not.toBeInTheDocument();

    await user.type(
      screen.getByRole('searchbox', { name: '搜索 Codex 插件' }),
      'office'
    );
    expect(screen.queryByText('Browser Tools')).not.toBeInTheDocument();
    expect(screen.queryByText('VibeX Office')).not.toBeInTheDocument();

    await user.click(within(tabs).getByRole('tab', { name: 'VibeX' }));
    expect((await screen.findAllByText('VibeX Office')).length).toBeGreaterThan(
      0
    );
    expect(screen.getByText('Research Toolkit')).toBeVisible();
    const officeRow = screen.getByRole('button', { name: /VibeX Office/ });
    expect(within(officeRow).queryByText('VibeX')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Research Toolkit/ }));
    const detail = screen.getByRole('region', { name: 'Research Toolkit' });
    const detailHeader = detail.querySelector('.plugin-detail-header');
    expect(detailHeader).not.toBeNull();
    expect(
      within(detailHeader as HTMLElement).getByText('VibeX')
    ).toBeVisible();
    expect(
      within(detailHeader as HTMLElement).getByText('Codex')
    ).toBeVisible();
    expect(
      within(detailHeader as HTMLElement).getByText('Claude Code')
    ).toBeVisible();
    expect(within(detail).getByText('VibeX')).toBeVisible();
    expect(within(detail).getByText('Codex')).toBeVisible();
    expect(within(detail).getByText('Claude Code')).toBeVisible();
    expect(within(detail).getByText('2 个技能')).toBeVisible();
    expect(within(detail).getByText('1 个 MCP')).toBeVisible();
    expect(within(detail).getByText('./install.sh')).toBeVisible();
    expect(within(detail).getByRole('heading', { name: '来源' })).toBeVisible();

    await user.click(within(tabs).getByRole('tab', { name: 'Claude Code' }));
    expect(screen.getAllByText('Frontend Design').length).toBeGreaterThan(0);
    expect(screen.queryByText('Research Toolkit')).not.toBeInTheDocument();
  });

  it('resizes the catalog and preview panes by dragging or using the keyboard', async () => {
    const backend = transport();
    renderSettings(backend.value);

    const separator = await screen.findByRole('separator', {
      name: '调整插件列表宽度',
    });
    const grid = separator.closest('.plugin-hub-grid');
    expect(grid).not.toBeNull();
    vi.spyOn(grid as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 1100,
      top: 0,
      bottom: 600,
      width: 1000,
      height: 600,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(separator, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(separator, 'releasePointerCapture', {
      configurable: true,
      value: vi.fn(),
    });

    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 410 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 540 });
    fireEvent.pointerUp(separator, { pointerId: 1 });

    expect(separator).toHaveAttribute('aria-valuenow', '44');
    expect(grid).toHaveStyle('--plugin-list-width: 44%');

    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(separator).toHaveAttribute('aria-valuenow', '42');
    expect(localStorage.getItem('vibex.pluginHub.listPanePercent')).toBe('42');
  });

  it('orders the overview sections and shows MCP names without their configuration', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value);

    await user.click(await screen.findByRole('tab', { name: 'VibeX' }));
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );

    const detail = screen.getByRole('region', { name: 'Research Toolkit' });
    expect(within(detail).getByText('2 个工作流')).toBeVisible();
    expect(within(detail).getByText('research-mcp')).toBeVisible();
    expect(
      within(detail).queryByText('research-mcp serve')
    ).not.toBeInTheDocument();
    expect(within(detail).getByText('开始研究')).toBeVisible();
    expect(within(detail).getByText('整理引用')).toBeVisible();
    expect(
      within(detail).queryByText('Run the research workflow.')
    ).not.toBeInTheDocument();

    const headings = within(detail)
      .getAllByRole('heading', { level: 4 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      '扩展 VibeX',
      '扩展 Agent',
      'Skills',
      'Runtime',
      'MCP',
      'Workflows',
      '来源',
    ]);
  });

  it('enables through the unified command and offers all-agent or MCP settings', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value, true);
    await user.click(await screen.findByRole('tab', { name: 'VibeX' }));
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );

    await user.click(
      screen.getByRole('switch', { name: '启用 Research Toolkit' })
    );
    await user.click(
      within(
        await screen.findByRole('alertdialog', {
          name: '允许 Research Toolkit 使用这些能力？',
        })
      ).getByRole('button', { name: '允许并启用' })
    );

    expect(backend.call).toHaveBeenCalledWith('plugin_control_set_enabled', {
      pluginId: 'dev.vibex.research',
      enabled: true,
    });
    expect(backend.call).toHaveBeenCalledWith(
      'plugin_control_configure_agents',
      {
        pluginId: 'dev.vibex.research',
        allAgents: true,
        agents: [],
      }
    );
    const dialog = await screen.findByRole('dialog', { name: '配置插件能力' });
    expect(within(dialog).getAllByText(/内置 MCP/).length).toBeGreaterThan(0);
    expect(
      within(dialog).getByRole('button', {
        name: '跳过并为全部 Agent 启用 MCP',
      })
    ).toBeVisible();

    await user.click(
      within(dialog).getByRole('button', { name: '前往 MCP 设置' })
    );
    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      '/settings/mcp?plugin=dev.vibex.research'
    );
  });

  it('uses official native lifecycle actions instead of a disabled switch', async () => {
    const user = userEvent.setup();
    const backend = transport({
      plugin_control_set_enabled: {
        ...catalog.plugins[3],
        enabled: false,
      },
      plugin_control_update: catalog.plugins[3],
    });
    renderSettings(backend.value);

    const codexDetail = await screen.findByRole('region', {
      name: 'Browser Tools',
    });
    expect(within(codexDetail).queryByRole('switch')).not.toBeInTheDocument();
    expect(
      within(codexDetail).queryByText('由原生管理器控制')
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Claude Code' }));
    const claudeDetail = await screen.findByRole('region', {
      name: 'Frontend Design',
    });
    expect(within(claudeDetail).queryByRole('switch')).not.toBeInTheDocument();

    await user.click(
      within(claudeDetail).getByRole('button', {
        name: '更新 Frontend Design',
      })
    );
    expect(backend.call).toHaveBeenCalledWith('plugin_control_update', {
      pluginId: 'anthropic.frontend',
    });

    await user.click(
      within(claudeDetail).getByRole('button', {
        name: '停用 Frontend Design',
      })
    );
    expect(backend.call).toHaveBeenCalledWith('plugin_control_set_enabled', {
      pluginId: 'anthropic.frontend',
      enabled: false,
    });
    expect(backend.call).not.toHaveBeenCalledWith(
      'plugin_control_configure_agents',
      expect.anything()
    );

    await user.click(
      within(claudeDetail).getByRole('button', { name: '卸载插件' })
    );
    expect(
      await screen.findByText(/调用对应 Agent 的官方命令卸载/)
    ).toBeVisible();
  });

  it('opens a Skill-only view and previews each SKILL.md on demand', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value);

    await user.click(await screen.findByRole('tab', { name: 'VibeX' }));
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );
    await user.click(screen.getByRole('button', { name: '2 个技能' }));

    expect(backend.call).toHaveBeenCalledWith('plugin_control_contributions', {
      pluginId: 'dev.vibex.research',
    });
    const skillView = await screen.findByRole('region', {
      name: 'Research Toolkit 技能',
    });
    expect(
      within(skillView).getByRole('heading', { name: 'Research workflow' })
    ).toBeVisible();

    await user.click(
      within(skillView).getByRole('button', { name: 'citations' })
    );
    expect(
      within(skillView).getByRole('heading', { name: 'Citation workflow' })
    ).toBeVisible();
    expect(within(skillView).queryByText('来源')).not.toBeInTheDocument();
    expect(within(skillView).queryByText('Runtime')).not.toBeInTheDocument();
  });

  it('opens an MCP-only view and renders each server configuration as JSON', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value);

    await user.click(await screen.findByRole('tab', { name: 'VibeX' }));
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );
    await user.click(screen.getByRole('button', { name: '1 个 MCP' }));

    const mcpView = await screen.findByRole('region', {
      name: 'Research Toolkit MCP',
    });
    expect(
      within(mcpView).getByRole('button', { name: 'research-mcp' })
    ).toBeVisible();
    expect(
      within(mcpView).getByText(/"command": "research-mcp"/)
    ).toBeVisible();
    expect(within(mcpView).getByText(/"args": \[/)).toBeVisible();
    expect(within(mcpView).queryByText('来源')).not.toBeInTheDocument();
    expect(within(mcpView).queryByText('Runtime')).not.toBeInTheDocument();
  });

  it('falls back to existing file IPC when the desktop backend has not restarted', async () => {
    const user = userEvent.setup();
    const backend = transport({
      plugin_control_contributions: () => {
        throw new Error('Command plugin_control_contributions not found');
      },
      read_file_content: (args: unknown) => {
        const { path } = args as { path: string };
        if (path.endsWith('skills/research/SKILL.md')) {
          return '# Research fallback\n\nLoaded through the file API.';
        }
        if (path.endsWith('skills/citations/SKILL.md')) {
          return '# Citations fallback';
        }
        if (path.endsWith('.vibex-plugin/plugin.json')) {
          return JSON.stringify({
            mcp: {
              mcpServers: {
                'research-mcp': {
                  command: 'research-mcp',
                  args: ['serve'],
                },
              },
            },
          });
        }
        throw new Error(`unexpected file: ${path}`);
      },
    });
    renderSettings(backend.value);

    await user.click(await screen.findByRole('tab', { name: 'VibeX' }));
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );
    await user.click(screen.getByRole('button', { name: '2 个技能' }));

    expect(
      await screen.findByRole('heading', { name: 'Research fallback' })
    ).toBeVisible();
    expect(backend.call).toHaveBeenCalledWith('read_file_content', {
      path: '/Users/me/plugins/research/skills/research/SKILL.md',
    });

    await user.click(screen.getByRole('button', { name: '1 个 MCP' }));
    const mcpView = await screen.findByRole('region', {
      name: 'Research Toolkit MCP',
    });
    expect(
      within(mcpView).getByText(/"command": "research-mcp"/)
    ).toBeVisible();
  });

  it('runs an official CLI import with visible logs and result', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value);

    await user.click(await screen.findByRole('button', { name: '导入插件' }));
    const dialog = await screen.findByRole('dialog', { name: '选择插件格式' });
    expect(within(dialog).queryByText('ChatGPT V1')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('ChatGPT V2')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Codex' })).toBeVisible();
    expect(
      within(dialog).getByRole('button', { name: /Claude Code/ })
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: /VibeX/ })).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Codex' }));
    expect(within(dialog).getByText('仅 Skills 的 ZIP')).toBeVisible();
    const command = within(dialog).getByRole('textbox', {
      name: 'Codex CLI 命令',
    });
    await user.type(
      command,
      'codex plugin marketplace add official\n' +
        'codex plugin add frontend-design@official'
    );
    await user.click(
      within(dialog).getByRole('button', { name: '运行并导入' })
    );

    expect(backend.stream).toHaveBeenCalledWith(
      'plugin_control_import_cli',
      {
        ecosystem: 'codex',
        command:
          'codex plugin marketplace add official\n' +
          'codex plugin add frontend-design@official',
      },
      expect.any(Function)
    );
    expect(await within(dialog).findByRole('log')).toHaveTextContent(
      'Installed frontend-design@official'
    );
    expect(within(dialog).getByText('导入完成')).toBeVisible();
    expect(within(dialog).getByText('frontend-design@official')).toBeVisible();

    await user.click(
      within(dialog).getByRole('button', { name: /Claude Code/ })
    );
    expect(
      within(dialog).getByRole('textbox', { name: 'Claude Code CLI 命令' })
    ).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: /^VibeX/ }));
    expect(within(dialog).getByText('VibeX 插件 ZIP')).toBeVisible();
    expect(within(dialog).queryByText(/CLI/)).not.toBeInTheDocument();
  });

  it('previews a VibeX ZIP and requires an explicit same-id replacement decision', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue('/Users/me/new-research.zip');
    const preview = {
      plugin: catalog.plugins[1],
      conflict: {
        pluginId: 'dev.vibex.research',
        installedSource: '/Users/me/plugins/research',
        installedEnabled: true,
        incomingSource: '/Users/me/new-research',
      },
    };
    const backend = transport({
      plugin_control_preview_import: preview,
      plugin_control_import: catalog.plugins[1],
    });
    renderSettings(backend.value);

    await user.click(await screen.findByRole('button', { name: '导入插件' }));
    const chooser = await screen.findByRole('dialog', {
      name: '选择插件格式',
    });
    await user.click(within(chooser).getByRole('button', { name: /^VibeX/ }));
    await user.click(within(chooser).getByRole('button', { name: '选择 ZIP' }));
    const dialog = await screen.findByRole('dialog', {
      name: '导入 Research Toolkit',
    });
    expect(within(dialog).getByText(/相同插件 ID/)).toBeVisible();
    expect(
      within(dialog).getByText('/Users/me/plugins/research')
    ).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: '覆盖安装' }));
    const permissionDialog = await screen.findByRole('alertdialog', {
      name: '审查 Research Toolkit 更新后的能力',
    });
    expect(
      within(permissionDialog).getByText('写入插件生成的文件')
    ).toBeVisible();
    await user.click(
      within(permissionDialog).getByRole('button', { name: '确认并更新' })
    );
    expect(backend.call).toHaveBeenCalledWith('plugin_control_import', {
      path: '/Users/me/new-research.zip',
      developerLink: false,
      conflictDecision: 'replace',
      packageKind: 'vibex',
      permissionIds: ['research-export'],
    });
  });

  it('installs a content-addressed Runtime without displacing other versions', async () => {
    const user = userEvent.setup();
    const backend = transport({
      plugin_control_install_runtime: {
        id: 'research-cli',
        version: '1.4.0',
        executablePath: '/Users/me/.local/bin/research',
      },
    });
    renderSettings(backend.value);
    await user.click(await screen.findByRole('tab', { name: 'VibeX' }));
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );

    await user.click(screen.getByRole('button', { name: '安装 research-cli' }));

    await waitFor(() =>
      expect(backend.call).toHaveBeenCalledWith(
        'plugin_control_install_runtime',
        {
          pluginId: 'dev.vibex.research',
          runtimeId: 'research-cli',
        }
      )
    );
  });

  it('renders each Runtime identity and only marks an exact lock ready', async () => {
    const backend = transport();
    renderSettings(backend.value, false, 'vibex');

    const detail = await screen.findByRole('region', { name: 'VibeX Office' });
    expect(within(detail).getByText('已就绪')).toBeVisible();
    expect(screen.getByText('sha256:officecli-1.0.140')).toBeVisible();
    expect(screen.getByText('sha256:officecli-1.0.139')).toBeVisible();
    expect(screen.getByText(/aarch64-apple-darwin/)).toBeVisible();
    expect(screen.getByText(/x86_64-apple-darwin/)).toBeVisible();
    expect(screen.getByText(/所有权：managed/)).toBeVisible();
    expect(screen.getByText(/所有权：external/)).toBeVisible();
  });

  it('reviews package-digest-scoped permissions before enabling a third-party plugin', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value);
    await user.click(await screen.findByRole('tab', { name: 'VibeX' }));
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );

    await user.click(
      screen.getByRole('switch', { name: '启用 Research Toolkit' })
    );

    const dialog = await screen.findByRole('alertdialog', {
      name: '允许 Research Toolkit 使用这些能力？',
    });
    expect(
      within(dialog).getByText('运行插件声明的本地 Runtime')
    ).toBeVisible();
    expect(within(dialog).getAllByText('Acme Research')[0]).toBeVisible();
    expect(within(dialog).getByText('必需')).toBeVisible();
    const optionalPermission = within(dialog).getByRole('checkbox', {
      name: /Fetch optional external references/,
    });
    expect(optionalPermission).not.toBeChecked();
    expect(
      within(dialog).getByText('Run the locked research runtime.')
    ).toBeVisible();
    expect(within(dialog).getByText(/插件包更新后必须重新确认/)).toBeVisible();
    await user.click(within(dialog).getByText('发布者与包校验信息'));
    expect(within(dialog).getByText('sha256:research-1.4.0')).toBeVisible();

    await user.click(
      within(dialog).getByRole('button', { name: '允许并启用' })
    );
    expect(backend.call).toHaveBeenCalledWith(
      'plugin_control_grant_permissions',
      {
        pluginId: 'dev.vibex.research',
        permissionIds: ['run-research'],
      }
    );
    expect(backend.call).toHaveBeenCalledWith('plugin_control_set_enabled', {
      pluginId: 'dev.vibex.research',
      enabled: true,
    });
  });

  it('uses the same permission decision for builtin packages', async () => {
    const user = userEvent.setup();
    const office = {
      ...catalog.plugins[0],
      enabled: false,
      permissions: [
        {
          id: 'office-preview',
          capability: 'artifact.preview',
          scope: { formats: ['docx', 'pptx', 'xlsx'] },
          reason: 'Preview Office files in the workbench.',
          optional: false,
          trustTier: 'trusted_native' as const,
        },
      ],
    };
    const backend = transport({
      plugin_control_catalog: {
        ...catalog,
        plugins: [office, ...catalog.plugins.slice(1)],
      },
      plugin_control_set_enabled: { ...office, enabled: true },
    });
    renderSettings(backend.value, false, 'vibex');

    await user.click(
      await screen.findByRole('switch', { name: '启用 VibeX Office' })
    );
    const dialog = await screen.findByRole('alertdialog', {
      name: '允许 VibeX Office 使用这些能力？',
    });
    expect(dialog.tagName).toBe('DIALOG');
    expect(within(dialog).getAllByText('VibeX')[0]).toBeVisible();
    expect(within(dialog).getByText('运行 OfficeCLI')).toBeVisible();
    const allow = within(dialog).getByRole('button', {
      name: '允许、安装并启用',
    });
    expect(allow).toBeDisabled();
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: /运行经过校验的 OfficeCLI/,
      })
    );
    expect(allow).toBeEnabled();
    expect(backend.call).not.toHaveBeenCalledWith(
      'plugin_control_set_enabled',
      expect.anything()
    );
  });

  it('prepares required runtimes before enabling and toasts activation failures', async () => {
    const user = userEvent.setup();
    const office = {
      ...catalog.plugins[0],
      enabled: false,
      permissions: [
        {
          id: 'office-preview',
          capability: 'artifact.preview',
          scope: { providers: ['office-preview'] },
          reason: 'Preview Office files in the workbench.',
          optional: false,
          trustTier: 'trusted_native' as const,
        },
      ],
    };
    const backend = transport({
      plugin_control_catalog: {
        ...catalog,
        plugins: [office, ...catalog.plugins.slice(1)],
        runtimes: [],
      },
      plugin_control_install_runtime: {
        id: 'officecli',
        version: '1.0.140',
      },
      plugin_control_set_enabled: () => {
        throw new Error('OfficeCLI probe failed');
      },
    });
    renderSettings(backend.value, false, 'vibex');

    await user.click(
      await screen.findByRole('switch', { name: '启用 VibeX Office' })
    );
    const dialog = await screen.findByRole('alertdialog', {
      name: '允许 VibeX Office 使用这些能力？',
    });
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: /运行经过校验的 OfficeCLI/,
      })
    );
    await user.click(
      within(dialog).getByRole('button', { name: '允许、安装并启用' })
    );

    await waitFor(() => {
      const installCall = backend.call.mock.invocationCallOrder.find(
        (_, index) =>
          backend.call.mock.calls[index]?.[0] ===
          'plugin_control_install_runtime'
      );
      const enableCall = backend.call.mock.invocationCallOrder.find(
        (_, index) =>
          backend.call.mock.calls[index]?.[0] === 'plugin_control_set_enabled'
      );
      expect(installCall).toBeDefined();
      expect(enableCall).toBeDefined();
      expect(installCall).toBeLessThan(enableCall as number);
      expect(toast.error).toHaveBeenCalledWith('无法启用 VibeX Office', {
        description: 'OfficeCLI probe failed',
      });
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      '操作失败：OfficeCLI probe failed'
    );
  });

  it('reviews the incoming permission delta and digest before update', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value, false, 'vibex');
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );

    await user.click(
      screen.getByRole('button', { name: '更新 Research Toolkit' })
    );
    const dialog = await screen.findByRole('alertdialog', {
      name: '审查 Research Toolkit 更新后的能力',
    });
    expect(within(dialog).getByText('权限增量')).toBeVisible();
    expect(within(dialog).getByText('写入插件生成的文件')).toBeVisible();
    await user.click(within(dialog).getByText('发布者与包校验信息'));
    expect(within(dialog).getByText('sha256:research-1.5.0')).toBeVisible();
    expect(
      within(dialog).queryByText('运行插件声明的本地 Runtime')
    ).not.toBeInTheDocument();
  });

  it('restores the previous verified package through the rollback command', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value, false, 'vibex');
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );

    await user.click(
      screen.getByRole('button', {
        name: '恢复 Research Toolkit 上一个经过校验的版本',
      })
    );

    await waitFor(() => {
      expect(backend.call).toHaveBeenCalledWith('plugin_control_rollback', {
        pluginId: 'dev.vibex.research',
        permissionIds: [],
      });
    });
  });
});
