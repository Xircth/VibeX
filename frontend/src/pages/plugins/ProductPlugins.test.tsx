import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { open } from '@tauri-apps/plugin-dialog';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendTransportProvider } from '@/lib/transport';
import type { BackendTransport } from '@/lib/backendTransport';
import {
  MarketplacePluginDetailPage,
  PluginCatalogPage,
  PluginDetailPage,
} from './ProductPlugins';

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

const webviewMock = vi.hoisted(() => ({
  handler: null as ((event: unknown) => void) | null,
  onDragDropEvent: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => ({ toast: toastMock }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: webviewMock.onDragDropEvent,
  }),
}));

const plugin = {
  id: 'office',
  publisher: 'vibex',
  packageDigest: 'digest',
  name: 'VibeX Office',
  version: '4.0.0',
  description: 'Preview and work with Office documents.',
  enabled: true,
  builtin: true,
  sourceKind: 'builtin',
  sourcePath: '/plugin/office',
  formats: ['vibex'],
  skills: [],
  runtimes: [],
  warnings: [],
  permissions: [],
  enableSupported: true,
};

const drawioPlugin = {
  ...plugin,
  id: 'drawio',
  packageDigest: 'drawio-digest',
  name: 'Drawio',
  version: '1.0.0',
  description: 'Preview and edit Drawio diagrams.',
  enabled: false,
  builtin: false,
  sourceKind: 'archive',
  sourcePath: '/Users/mac/Projects/vibex-drawio/dist/drawio-1.0.0.vxp',
};

const detail = {
  summary: 'Preview and work with Office documents.',
  readme: '# VibeX Office\n\nOpen Word, Excel, and PowerPoint files.',
  contents: [
    {
      path: 'contents/skills/office-docx/SKILL.md',
      kind: 'skill',
      title: 'Word document',
      content: '# Office DOCX\n\nCreate and modify DOCX artifacts.',
    },
    {
      path: 'contents/workflows/create-presentation/workflow.json',
      kind: 'workflow',
      title: 'Create presentation',
      content: '{"steps":[]}',
    },
  ],
  config: { preview: true, idleTimeoutMinutes: 10 },
  configSchema: {
    type: 'object',
    properties: {
      preview: { type: 'boolean', title: 'Document preview' },
      idleTimeoutMinutes: {
        type: 'integer',
        title: 'Idle timeout',
        minimum: 1,
        maximum: 60,
      },
    },
  },
};

function renderRoute(
  path: string,
  call = vi.fn(),
  capabilities = ['plugin.read', 'plugin.write']
) {
  const transport: BackendTransport = {
    environment: 'desktop',
    call,
    capabilities: vi.fn().mockResolvedValue({
      server_version: 'desktop',
      protocol_version: '1.0',
      minimum_client_version: '0.1.0',
      capabilities,
    }),
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BackendTransportProvider transport={transport}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/plugins" element={<PluginCatalogPage />} />
            <Route
              path="/plugins/marketplace/:owner/:pluginName"
              element={<MarketplacePluginDetailPage />}
            />
            <Route path="/plugins/:pluginId" element={<PluginDetailPage />} />
          </Routes>
        </MemoryRouter>
      </BackendTransportProvider>
    </QueryClientProvider>
  );
  return call;
}

describe('product plugin experience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webviewMock.handler = null;
    webviewMock.onDragDropEvent.mockImplementation(async (handler) => {
      webviewMock.handler = handler;
      return webviewMock.unlisten;
    });
  });

  it('shows a structured plugin list loading state', async () => {
    let resolveCatalog: ((value: unknown) => void) | undefined;
    const call = vi.fn((command: string) => {
      if (command !== 'plugin_control_catalog') {
        return Promise.reject(new Error(command));
      }
      return new Promise((resolve) => {
        resolveCatalog = resolve;
      });
    });
    renderRoute('/plugins', call);

    expect(
      await screen.findByRole('status', {
        name: /正在加载插件|loading plugins/i,
      })
    ).toBeVisible();

    resolveCatalog?.({ plugins: [plugin], runtimes: [] });
    expect(await screen.findByText('VibeX Office')).toBeVisible();
  });

  it('reports catalog failures through a localized toast', async () => {
    renderRoute('/plugins', vi.fn().mockRejectedValue(new Error('offline')));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('插件列表加载失败', {
        description: 'offline',
      })
    );
  });

  it('reveals the detail header and content as one complete page', async () => {
    let resolveCatalog: ((value: unknown) => void) | undefined;
    let resolveDetail: ((value: unknown) => void) | undefined;
    const call = vi.fn((command: string) => {
      if (command === 'plugin_control_catalog') {
        return new Promise((resolve) => {
          resolveCatalog = resolve;
        });
      }
      if (command === 'plugin_product_detail') {
        return new Promise((resolve) => {
          resolveDetail = resolve;
        });
      }
      return Promise.reject(new Error(command));
    });
    renderRoute('/plugins/office', call);

    await waitFor(() => expect(resolveCatalog).toBeTypeOf('function'));
    await waitFor(() => expect(resolveDetail).toBeTypeOf('function'));
    await act(async () => resolveDetail?.(detail));

    expect(
      screen.getByRole('status', {
        name: /正在加载插件详情|loading plugin detail/i,
      })
    ).toBeVisible();
    expect(
      screen.queryByRole('tablist', { name: /插件详情|plugin detail/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: /插件内容|plugin content/i })
    ).not.toBeInTheDocument();

    await act(async () =>
      resolveCatalog?.({ plugins: [plugin], runtimes: [] })
    );

    expect(
      await screen.findByRole('tablist', { name: /插件详情|plugin detail/i })
    ).toBeVisible();
    expect(screen.getByRole('tab', { name: /README/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('article', { name: /README/i })).toBeVisible();
    expect(
      screen.queryByRole('region', { name: /插件内容|plugin contents/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: /包结构|Package/ })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: 'Document preview' })
    ).not.toBeInTheDocument();
  });

  it('shows one product-oriented list row and no internal contribution metrics', async () => {
    const call = vi.fn().mockResolvedValue({ plugins: [plugin], runtimes: [] });
    renderRoute('/plugins', call, [
      'plugin.read',
      'plugin.write',
      'desktop.tauri',
    ]);

    expect(await screen.findByText('VibeX Office')).toBeVisible();
    expect(
      screen.getByText('Preview and work with Office documents.')
    ).toBeVisible();
    expect(
      screen.queryByText(/activation generation/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/runtime/i)).not.toBeInTheDocument();
    const search = screen.getByRole('searchbox', {
      name: /搜索插件|search plugins/i,
    });
    expect(search.parentElement).toHaveAttribute(
      'data-control-frame',
      'single'
    );
    expect(
      screen.queryByRole('button', { name: /目录|catalog/i })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /通过插件扩展平台能力，新建会话后生效|Extend the platform with plugins/i
      )
    ).toBeVisible();
    expect(
      screen
        .getByRole('heading', { name: '插件' })
        .closest('.chat-channel-heading')
    ).toBeTruthy();
    expect(
      screen.getByText(
        /通过插件扩展平台能力，新建会话后生效|Extend the platform with plugins/i
      ).parentElement
    ).toHaveClass('product-plugins-intro-row');
    expect(
      screen.getByRole('tab', { name: /已安装|installed/i })
    ).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByRole('tab', { name: /插件市场|marketplace/i })
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: /添加插件|add plugin/i })
    ).toHaveClass('primary-control');
    expect(
      screen.getByRole('region', { name: /插件目录|plugin catalog/i })
    ).toHaveClass('product-plugin-catalog-body');
  });

  it('refreshes the catalog immediately after adding a packaged plugin', async () => {
    vi.mocked(open).mockResolvedValue(drawioPlugin.sourcePath);
    let catalogRequests = 0;
    let resolveInitialCatalog: ((value: unknown) => void) | undefined;
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_control_catalog') {
        catalogRequests += 1;
        if (catalogRequests === 1) {
          return new Promise((resolve) => {
            resolveInitialCatalog = resolve;
          });
        }
        return {
          plugins: [plugin, drawioPlugin],
          runtimes: [],
        };
      }
      if (command === 'plugin_check_updates') return [];
      if (command === 'plugin_control_preview_import') {
        return { plugin: drawioPlugin, conflict: null };
      }
      if (command === 'plugin_control_import') return drawioPlugin;
      throw new Error(command);
    });
    renderRoute('/plugins', call, [
      'plugin.read',
      'plugin.write',
      'desktop.tauri',
    ]);

    fireEvent.click(
      await screen.findByRole('button', { name: /添加插件|add plugin/i })
    );
    const trustDialog = await screen.findByRole('dialog');
    expect(trustDialog).toHaveTextContent('Drawio');
    expect(trustDialog).toHaveTextContent(/来源|Source/);
    expect(trustDialog).toHaveTextContent(/本机文件|Local file/);
    expect(trustDialog).toHaveTextContent(/权限|Permissions/);
    expect(trustDialog).not.toHaveTextContent(
      'Preview and edit Drawio diagrams.'
    );
    fireEvent.click(
      within(trustDialog).getByRole('button', { name: /安装|install/i })
    );

    expect(await screen.findByText('Drawio')).toBeVisible();
    expect(catalogRequests).toBeGreaterThanOrEqual(2);
    await act(async () => {
      resolveInitialCatalog?.({ plugins: [plugin], runtimes: [] });
    });
    expect(screen.getByText('Drawio')).toBeVisible();
  });

  it('replaces a same-id package after explicit confirmation and binds its capabilities to all agents', async () => {
    const installed = {
      ...drawioPlugin,
      id: 'vibex.workflow-creator',
      name: 'VibeX Workflow Creator',
      version: '1.0.0',
      sourceKind: 'builtin',
      sourcePath: '/app/builtin/vibex.workflow-creator',
      enabled: true,
    };
    const incoming = {
      ...installed,
      version: '1.0.1',
      sourceKind: 'snapshot',
      sourcePath: '/Users/me/vibex.workflow-creator-1.0.1.vxp',
      skills: [{ id: 'vibex-workflow-creator', path: 'contents/skills' }],
      mcpCount: 1,
      mcpServers: ['vibex-workflow-mcp'],
    };
    vi.mocked(open).mockResolvedValue(incoming.sourcePath);
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_control_catalog') {
        return { plugins: [incoming], runtimes: [] };
      }
      if (command === 'plugin_check_updates') return [];
      if (command === 'plugin_control_preview_import') {
        return {
          plugin: incoming,
          conflict: {
            pluginId: incoming.id,
            installedSource: installed.sourcePath,
            incomingSource: incoming.sourcePath,
            installedEnabled: true,
          },
        };
      }
      if (command === 'plugin_control_import') return incoming;
      if (command === 'plugin_control_set_enabled') {
        return { ...incoming, enabled: true };
      }
      if (
        command === 'plugin_control_configure_agents' ||
        command === 'plugin_control_configure_mcp'
      ) {
        return {};
      }
      throw new Error(command);
    });
    renderRoute('/plugins', call, [
      'plugin.read',
      'plugin.write',
      'desktop.tauri',
    ]);

    fireEvent.click(
      await screen.findByRole('button', { name: /添加插件|add plugin/i })
    );
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('plugin_control_preview_import', {
        path: incoming.sourcePath,
        developerLink: false,
        packageKind: 'vibex',
      })
    );
    expect(
      await screen.findByText(
        /存在相同插件 ID|A plugin with the same ID exists/i
      )
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: /覆盖安装|replace plugin/i })
    );

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('plugin_control_import', {
        path: incoming.sourcePath,
        developerLink: false,
        conflictDecision: 'replace',
        packageKind: 'vibex',
        permissionIds: [],
      })
    );
    expect(call).not.toHaveBeenCalledWith(
      'plugin_control_set_enabled',
      expect.anything()
    );
  });

  it('installs a vxp dropped onto the plugin page', async () => {
    let catalogRequests = 0;
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_control_catalog') {
        catalogRequests += 1;
        return {
          plugins: catalogRequests === 1 ? [plugin] : [plugin, drawioPlugin],
          runtimes: [],
        };
      }
      if (command === 'plugin_check_updates') return [];
      if (command === 'plugin_control_preview_import') {
        return { plugin: drawioPlugin, conflict: null };
      }
      if (command === 'plugin_control_import') return drawioPlugin;
      throw new Error(command);
    });
    renderRoute('/plugins', call, [
      'plugin.read',
      'plugin.write',
      'desktop.tauri',
    ]);

    await waitFor(() => expect(webviewMock.handler).not.toBeNull());
    act(() => {
      webviewMock.handler?.({
        payload: {
          type: 'enter',
          paths: [drawioPlugin.sourcePath],
          position: { x: 100, y: 100 },
        },
      });
    });
    expect(
      screen.getByRole('status', {
        name: /松开以安装|drop to install/i,
      })
    ).toBeVisible();

    act(() => {
      webviewMock.handler?.({
        payload: {
          type: 'drop',
          paths: [drawioPlugin.sourcePath],
          position: { x: 100, y: 100 },
        },
      });
    });

    const droppedTrust = await screen.findByRole('dialog');
    expect(droppedTrust).toHaveTextContent('Drawio');
    expect(droppedTrust).toHaveTextContent(/本机文件|Local file/);
    expect(droppedTrust).not.toHaveTextContent(
      'Preview and edit Drawio diagrams.'
    );
    fireEvent.click(
      within(droppedTrust).getByRole('button', { name: /安装|install/i })
    );
    expect(await screen.findByText('Drawio')).toBeVisible();
    expect(call).toHaveBeenCalledWith('plugin_control_import', {
      path: drawioPlugin.sourcePath,
      developerLink: false,
      conflictDecision: 'reject',
      packageKind: 'vibex',
      permissionIds: [],
    });
  });

  it('enables a trusted product plugin without a permission gate', async () => {
    const disabledPlugin = {
      ...plugin,
      enabled: false,
      skills: [{ id: 'office', path: 'contents/skills/office/SKILL.md' }],
      permissions: [
        {
          id: 'native',
          capability: 'runtime.execute',
          scope: {},
          reason: 'Run the bundled runtime',
          optional: false,
          trustTier: 'trusted_native',
        },
      ],
    };
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_control_catalog') {
        return { plugins: [disabledPlugin], runtimes: [] };
      }
      if (command === 'plugin_control_set_enabled') {
        return { ...disabledPlugin, enabled: true };
      }
      if (command === 'plugin_control_configure_agents') {
        return { skillProjections: [], mcpErrors: [] };
      }
      throw new Error(command);
    });
    renderRoute('/plugins', call, [
      'plugin.read',
      'plugin.write',
      'desktop.tauri',
    ]);

    fireEvent.click(
      await screen.findByRole('switch', { name: /VibeX Office/i })
    );

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('plugin_control_set_enabled', {
        pluginId: 'office',
        enabled: true,
      })
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(call).not.toHaveBeenCalledWith(
      'plugin_control_grant_permissions',
      expect.anything()
    );
    expect(call).toHaveBeenCalledWith('plugin_control_configure_agents', {
      pluginId: 'office',
      allAgents: true,
      agents: [],
    });
  });

  it('opens the marketplace tab with official listings first', async () => {
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_control_catalog') {
        return { plugins: [plugin], runtimes: [] };
      }
      if (command === 'plugin_check_updates') return [];
      if (command === 'plugin_marketplace_catalog') {
        return {
          official: [
            {
              owner: 'vibex',
              pluginName: 'vibex.office',
              tag: '1.0.0',
              version: '1.0.0',
              displayName: 'VibeX Office',
              summary: 'Office files',
              category: 'productivity',
              sourceKind: 'official',
            },
          ],
          community: [
            {
              owner: 'acme',
              pluginName: 'notes',
              tag: '2.0.0',
              version: '2.0.0',
              displayName: 'Notes',
              summary: 'Take notes',
              category: 'community',
              sourceKind: 'github',
            },
          ],
          communityLimit: 50,
          query: '',
          remote: true,
        };
      }
      if (command === 'plugin_marketplace_listing') {
        return {
          listing: {
            owner: 'acme',
            pluginName: 'notes',
            tag: '2.0.0',
            version: '2.0.0',
            displayName: 'Notes',
            summary: 'Take notes',
            category: 'community',
            sourceKind: 'github',
          },
          summary: 'Take notes',
          readme: '# Notes\n\nTake notes in VibeX.',
          contents: [
            {
              path: 'contents/mcp/notes/server.json',
              kind: 'mcp',
              title: 'Notes MCP',
              content: '{"command":"notes-mcp"}',
            },
            {
              path: 'contents/skills/notes/SKILL.md',
              kind: 'skill',
              title: 'Notes skill',
              content: '# Notes skill',
            },
            {
              path: 'contents/runtimes/node.md',
              kind: 'runtime',
              title: 'Node',
              content: 'Node runtime',
            },
          ],
        };
      }
      throw new Error(command);
    });
    renderRoute('/plugins', call, [
      'plugin.read',
      'plugin.write',
      'desktop.tauri',
    ]);

    fireEvent.click(
      await screen.findByRole('tab', { name: /插件市场|marketplace/i })
    );
    expect(
      screen.getByRole('button', { name: /添加插件|add plugin/i })
    ).toBeVisible();
    expect(await screen.findByText('Notes')).toBeVisible();
    const notesRow = screen.getByText('Notes').closest('.product-plugin-row');
    expect(notesRow).not.toBeNull();
    expect(within(notesRow as HTMLElement).getByText('acme')).toBeVisible();
    expect(within(notesRow as HTMLElement).getByText('v2.0.0')).toBeVisible();
    expect(
      within(notesRow as HTMLElement).queryByText(
        /社区|Community|官方|Official/
      )
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: /插件市场|marketplace/i })
    ).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByRole('region', { name: /插件市场|marketplace/i })
    ).toHaveClass('product-plugin-catalog-body');
    expect(screen.getByRole('tab', { name: /^(全部|All)$/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(
      screen.getByRole('tab', { name: /^(官方|Official)$/ })
    ).toBeVisible();
    expect(
      screen.queryByRole('tab', { name: /^(社区|Community)$/ })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: /^(效率|Productivity)$/ })
    ).toBeVisible();
    expect(screen.getByText('办公套件')).toBeVisible();
    const officeRow = screen
      .getByText('办公套件')
      .closest('.product-plugin-row');
    expect(officeRow).not.toBeNull();
    expect(within(officeRow as HTMLElement).getByText('vibex')).toBeVisible();
    expect(
      within(officeRow as HTMLElement).getByText(/效率|Productivity/)
    ).toBeVisible();
    expect(
      within(officeRow as HTMLElement).getByText(/已安装|Installed/)
    ).toBeVisible();
    expect(
      within(officeRow as HTMLElement).queryByRole('button', {
        name: /^(安装|Install)$/,
      })
    ).not.toBeInTheDocument();
    expect(
      within(notesRow as HTMLElement).getByRole('button', {
        name: /^(安装|Install)$/,
      })
    ).toBeVisible();
    expect(screen.queryByText(/vibex\/vibex.office@/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /^(官方|Official)$/ }));
    expect(screen.queryByText('Notes')).not.toBeInTheDocument();
    expect(screen.getByText('办公套件')).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: /^(效率|Productivity)$/ }));
    expect(screen.queryByText('Notes')).not.toBeInTheDocument();
    expect(screen.getByText('办公套件')).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: /^(全部|All)$/ }));
    expect(screen.getByText('Notes')).toBeVisible();
    fireEvent.click(screen.getByText('Notes'));
    expect(
      (await screen.findAllByRole('heading', { name: 'Notes' }))[0]
    ).toBeVisible();
    expect(screen.getByRole('tab', { name: /README/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(
      screen.getByRole('tab', { name: /插件内容|Contents/ })
    ).toBeVisible();
    expect(screen.getByRole('tab', { name: /包结构|Package/ })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: /插件内容|Contents/ }));
    expect(screen.getByRole('heading', { name: 'MCP' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Skill' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Runtime' })).toBeVisible();
    expect(screen.getByText('Notes MCP')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'README.md' })
    ).not.toBeInTheDocument();
    expect(call).toHaveBeenCalledWith('plugin_marketplace_catalog', {
      query: null,
    });
    expect(call).toHaveBeenCalledWith('plugin_marketplace_listing', {
      owner: 'acme',
      pluginName: 'notes',
    });
    expect(screen.queryByText('http://127.0.0.1:4555')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: /返回插件|Back to plugins/i })
    );
    expect(
      await screen.findByRole('tab', { name: /插件市场|marketplace/i })
    ).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Notes')).toBeVisible();
  });

  it('marks a marketplace listing as installed after install succeeds', async () => {
    const notesListing = {
      owner: 'acme',
      pluginName: 'notes',
      tag: '2.0.0',
      version: '2.0.0',
      displayName: 'Notes',
      summary: 'Take notes',
      category: 'community',
      sourceKind: 'github',
    };
    const notesPlugin = {
      ...drawioPlugin,
      id: 'notes',
      publisher: 'acme',
      name: 'Notes',
      description: 'Take notes',
      sourceKind: 'marketplace',
      sourceOrigin: 'https://vibex.xforever.xin/marketplace/acme/notes',
    };
    let catalogPlugins = [plugin];
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_control_catalog') {
        return { plugins: catalogPlugins, runtimes: [] };
      }
      if (command === 'plugin_marketplace_catalog') {
        return {
          official: [],
          community: [notesListing],
          communityLimit: 50,
          query: '',
          remote: true,
        };
      }
      if (command === 'plugin_marketplace_install') {
        catalogPlugins = [plugin, notesPlugin];
        return notesPlugin;
      }
      throw new Error(command);
    });
    renderRoute('/plugins?tab=marketplace', call, [
      'plugin.read',
      'plugin.write',
      'desktop.tauri',
    ]);

    const notesRow = (await screen.findByText('Notes')).closest(
      '.product-plugin-row'
    ) as HTMLElement;
    fireEvent.click(
      within(notesRow).getByRole('button', { name: /^(安装|Install)$/ })
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: /^(安装|Install)$/ })
    );

    await waitFor(() => {
      expect(within(notesRow).getByText(/已安装|Installed/)).toBeVisible();
    });
    expect(
      within(notesRow).queryByRole('button', { name: /^(安装|Install)$/ })
    ).not.toBeInTheDocument();
    expect(call).toHaveBeenCalledWith('plugin_marketplace_install', {
      owner: 'acme',
      pluginName: 'notes',
      tag: '2.0.0',
      conflict: 'reject',
    });
  });

  it('shows installed status on a marketplace detail page for a catalog plugin', async () => {
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_control_catalog') {
        return { plugins: [plugin], runtimes: [] };
      }
      if (command === 'plugin_marketplace_listing') {
        return {
          listing: {
            owner: 'vibex',
            pluginName: 'vibex.office',
            tag: '1.0.0',
            version: '1.0.0',
            displayName: 'VibeX Office',
            summary: 'Office files',
            category: 'productivity',
            sourceKind: 'official',
            offlinePluginId: 'vibex.office',
          },
          summary: 'Office files',
          readme: '# Office',
          contents: [],
        };
      }
      throw new Error(command);
    });
    renderRoute('/plugins/marketplace/vibex/vibex.office', call);

    const heading = (
      await screen.findAllByRole('heading', { name: '办公套件' })
    )[0];
    expect(heading).toBeVisible();
    const detailHeader = heading.closest('header') as HTMLElement;
    expect(within(detailHeader).getByText(/已安装|Installed/)).toBeVisible();
    expect(
      within(detailHeader).queryByRole('button', { name: /^(安装|Install)$/ })
    ).not.toBeInTheDocument();
  });

  it('opens an independent detail page with content and config tabs', async () => {
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_control_catalog') {
        return { plugins: [plugin], runtimes: [] };
      }
      if (command === 'plugin_product_detail') return detail;
      if (command === 'plugin_save_config') return detail;
      throw new Error(command);
    });
    renderRoute('/plugins/office', call);

    expect(
      (await screen.findAllByRole('heading', { name: 'VibeX Office' }))[0]
    ).toBeVisible();
    expect(
      screen.getByText('Preview and work with Office documents.')
    ).toBeVisible();
    const detailHeading = screen.getAllByRole('heading', {
      name: 'VibeX Office',
    })[0];
    const detailHeader = detailHeading.closest('header');
    const metadata = screen.getByRole('group', {
      name: /插件元数据|plugin metadata/i,
    });
    expect(detailHeading.parentElement).toContainElement(metadata);
    expect(metadata).toHaveTextContent('内置');
    expect(metadata).toHaveTextContent('v4.0.0');
    expect(detailHeader).toBeTruthy();
    expect(
      screen.getByRole('tablist', { name: /插件详情|plugin detail/i })
    ).toBeVisible();
    expect(screen.getByRole('tab', { name: /README/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('article', { name: /README/i })).toBeVisible();
    expect(
      screen.queryByRole('tab', { name: /包结构|Package/ })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /插件内容|Contents/ }));
    const skillGroup = screen.getByRole('button', { name: /Skill/ });
    expect(skillGroup).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('heading', { name: 'Skill' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Workflow' })).toBeVisible();
    expect(screen.getByText('Word document')).toBeVisible();
    fireEvent.click(skillGroup);
    expect(skillGroup).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Word document')).not.toBeInTheDocument();
    fireEvent.click(skillGroup);
    expect(screen.getByText('Word document')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'SKILL.md' })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /配置|config/i }));
    expect(
      screen.getByRole('switch', { name: 'Document preview' })
    ).toBeVisible();
    expect(screen.getByRole('tab', { name: /配置|config/i })).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: /配置|config/i }));
    const previewSwitch = screen.getByRole('switch', {
      name: 'Document preview',
    });
    const timeout = screen.getByRole('spinbutton', { name: 'Idle timeout' });
    await waitFor(() => expect(previewSwitch).toBeEnabled());
    fireEvent.click(previewSwitch);
    fireEvent.change(timeout, { target: { value: '20' } });
    const save = screen.getByRole('button', { name: /保存|save/i });
    expect(save).toHaveClass('primary-control');
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('plugin_save_config', {
        pluginId: 'office',
        config: { preview: false, idleTimeoutMinutes: 20 },
      })
    );
  });

  it('shows source and version chips and official copy on the catalog', async () => {
    const official = {
      ...plugin,
      id: 'vibex.office',
      name: 'VibeX Office',
      description: 'Package summary that should be replaced.',
    };
    const call = vi.fn().mockResolvedValue({
      plugins: [official, drawioPlugin],
      runtimes: [],
    });
    renderRoute('/plugins', call);

    expect(await screen.findByText('办公套件')).toBeVisible();
    expect(
      screen.getByText(
        '在 VibeX 中创建、编辑、分析和预览 DOCX、XLSX 与 PPTX 文件。'
      )
    ).toBeVisible();
    const officialRow = screen
      .getByText('办公套件')
      .closest('.product-plugin-row');
    expect(officialRow).toHaveTextContent('v4.0.0');
    expect(officialRow).not.toHaveTextContent('vibex/vibex.office@');
    const installedRow = screen
      .getByText('Drawio')
      .closest('.product-plugin-row');
    expect(installedRow).toHaveTextContent('v1.0.0');
    expect(installedRow).not.toHaveTextContent('已安装');
    expect(
      officialRow?.querySelector('[data-official="office"]')
    ).not.toBeNull();
    expect(installedRow?.querySelector('[data-official]')).toBeNull();
  });

  it('uninstalls an installed plugin from the catalog context menu after confirmation', async () => {
    let catalogPlugins = [plugin, drawioPlugin];
    const call = vi.fn(
      async (command: string, args?: { pluginId?: string }) => {
        if (command === 'plugin_control_catalog') {
          return { plugins: catalogPlugins, runtimes: [] };
        }
        if (
          command === 'plugin_control_uninstall' ||
          command === 'plugin_uninstall'
        ) {
          catalogPlugins = catalogPlugins.filter(
            (item) => item.id !== args?.pluginId
          );
          return undefined;
        }
        throw new Error(command);
      }
    );
    renderRoute('/plugins', call);

    const installedRow = (await screen.findByText('Drawio')).closest(
      '.product-plugin-row'
    );
    expect(installedRow).not.toBeNull();
    fireEvent.contextMenu(installedRow as HTMLElement);

    const menu = await screen.findByRole('menu', { name: 'Drawio' });
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: /卸载插件|uninstall plugin/i })
    );

    const dialog = await screen.findByRole('dialog', {
      name: /卸载 Drawio|uninstall drawio/i,
    });
    expect(call).not.toHaveBeenCalledWith(
      'plugin_control_uninstall',
      expect.anything()
    );
    fireEvent.click(
      within(dialog).getByRole('button', { name: /确认卸载|uninstall/i })
    );

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('plugin_uninstall', {
        pluginId: 'drawio',
        retainData: true,
      })
    );
    await waitFor(() =>
      expect(screen.queryByText('Drawio')).not.toBeInTheDocument()
    );
    expect(toastMock.success).toHaveBeenCalledWith('已卸载 Drawio');
    expect(screen.getByText('VibeX Office')).toBeVisible();
  });

  it('offers uninstall for official marketplace packages', async () => {
    const call = vi.fn().mockResolvedValue({
      plugins: [
        {
          ...plugin,
          builtin: false,
          sourceKind: 'marketplace',
          uninstallSupported: true,
        },
        drawioPlugin,
      ],
      runtimes: [],
    });
    renderRoute('/plugins', call);

    const officialRow = (await screen.findByText('VibeX Office')).closest(
      '.product-plugin-row'
    );
    fireEvent.contextMenu(officialRow as HTMLElement);
    const menu = await screen.findByRole('menu', { name: 'VibeX Office' });
    expect(
      within(menu).getByRole('menuitem', {
        name: /卸载插件|uninstall plugin/i,
      })
    ).toBeVisible();
  });

  it('does not offer uninstall without plugin write access', async () => {
    const call = vi.fn().mockResolvedValue({
      plugins: [plugin, drawioPlugin],
      runtimes: [],
    });
    renderRoute('/plugins', call, ['plugin.read']);

    const installedRow = (await screen.findByText('Drawio')).closest(
      '.product-plugin-row'
    );
    fireEvent.contextMenu(installedRow as HTMLElement);
    const menu = await screen.findByRole('menu', { name: 'Drawio' });
    expect(
      within(menu).queryByRole('menuitem', {
        name: /卸载插件|uninstall plugin/i,
      })
    ).not.toBeInTheDocument();
  });

  it('keeps the plugin when uninstall confirmation is cancelled', async () => {
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_control_catalog') {
        return { plugins: [plugin, drawioPlugin], runtimes: [] };
      }
      throw new Error(command);
    });
    renderRoute('/plugins', call);

    const installedRow = (await screen.findByText('Drawio')).closest(
      '.product-plugin-row'
    );
    fireEvent.contextMenu(installedRow as HTMLElement);
    fireEvent.click(
      screen.getByRole('menuitem', { name: /卸载插件|uninstall plugin/i })
    );
    fireEvent.click(screen.getByRole('button', { name: /取消|cancel/i }));

    expect(call).not.toHaveBeenCalledWith(
      'plugin_control_uninstall',
      expect.anything()
    );
    expect(screen.getByText('Drawio')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reuses the catalog cache instead of refetching on remount', async () => {
    const call = vi.fn().mockResolvedValue({ plugins: [plugin], runtimes: [] });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
      capabilities: vi.fn().mockResolvedValue({
        server_version: 'desktop',
        protocol_version: '1.0',
        minimum_client_version: '0.1.0',
        capabilities: ['plugin.read', 'plugin.write'],
      }),
    };
    const view = render(
      <QueryClientProvider client={queryClient}>
        <BackendTransportProvider transport={transport}>
          <MemoryRouter initialEntries={['/plugins']}>
            <PluginCatalogPage />
          </MemoryRouter>
        </BackendTransportProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText('VibeX Office')).toBeVisible();
    const catalogCalls = () =>
      call.mock.calls.filter(
        ([command]) => command === 'plugin_control_catalog'
      );
    expect(catalogCalls()).toHaveLength(1);

    view.unmount();
    render(
      <QueryClientProvider client={queryClient}>
        <BackendTransportProvider transport={transport}>
          <MemoryRouter initialEntries={['/plugins']}>
            <PluginCatalogPage />
          </MemoryRouter>
        </BackendTransportProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText('VibeX Office')).toBeVisible();
    expect(catalogCalls()).toHaveLength(1);
  });
});
