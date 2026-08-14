import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendTransportProvider } from '@/lib/transport';
import type { BackendTransport } from '@/lib/backendTransport';
import { PluginCatalogPage, PluginDetailPage } from './ProductPlugins';

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => ({ toast: toastMock }));

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
  render(
    <BackendTransportProvider transport={transport}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/plugins" element={<PluginCatalogPage />} />
          <Route path="/plugins/:pluginId" element={<PluginDetailPage />} />
        </Routes>
      </MemoryRouter>
    </BackendTransportProvider>
  );
  return call;
}

describe('product plugin experience', () => {
  beforeEach(() => vi.clearAllMocks());

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
      screen.getByRole('tablist', { name: /插件详情|plugin detail/i })
    ).toBeVisible();
    expect(
      screen.getByRole('region', { name: /插件内容|plugin content/i })
    ).toBeVisible();
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
      name: /搜索已安装的插件|search installed plugins/i,
    });
    expect(search.parentElement).toHaveAttribute(
      'data-control-frame',
      'single'
    );
    expect(
      screen.getByRole('button', { name: /添加插件|add plugin/i })
    ).toHaveClass('primary-control');
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

  it('restores the desktop plugin development entry', async () => {
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_control_catalog') {
        return { plugins: [plugin], runtimes: [] };
      }
      if (command === 'plugin_dev_connection') {
        return { endpoint: 'http://127.0.0.1:4555', token: 'secret' };
      }
      throw new Error(command);
    });
    renderRoute('/plugins', call, [
      'plugin.read',
      'plugin.write',
      'desktop.tauri',
    ]);

    const development = await screen.findByRole('button', {
      name: /插件开发|plugin development/i,
    });
    expect(development).toHaveClass('raised-control');
    fireEvent.click(development);

    expect(
      await screen.findByRole('dialog', {
        name: /插件开发|plugin development/i,
      })
    ).toBeVisible();
    const dialog = screen.getByRole('dialog', {
      name: /插件开发|plugin development/i,
    });
    expect(dialog).toHaveClass('product-plugin-dev-dialog', 'max-w-md');
    expect(
      screen
        .getByText(/供插件作者连接|connect plugin authors/i)
        .closest('.gap-4')
    ).not.toHaveClass('max-w-md');
    expect(screen.getByText('http://127.0.0.1:4555')).toBeVisible();
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
      screen.getByText('Open Word, Excel, and PowerPoint files.')
    ).toBeVisible();
    const detailHeading = screen.getAllByRole('heading', {
      name: 'VibeX Office',
    })[0];
    const detailHeader = detailHeading.closest('header');
    const metadata = screen.getByRole('group', {
      name: /插件元数据|plugin metadata/i,
    });
    expect(detailHeading.parentElement).toContainElement(metadata);
    expect(metadata).toHaveTextContent('vibex');
    expect(metadata).toHaveTextContent('v4.0.0');
    expect(detailHeader).toContainElement(
      screen.getByRole('tablist', { name: /插件详情|plugin detail/i })
    );
    expect(
      screen.getByRole('region', { name: /插件内容|plugin content/i })
    ).toBeVisible();
    expect(
      screen.getByRole('region', { name: /内容预览|content preview/i })
    ).toBeVisible();
    expect(screen.queryByText('Word document')).not.toBeInTheDocument();
    const contentsFolder = screen.getByRole('button', { name: 'contents' });
    expect(contentsFolder).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(contentsFolder);
    expect(
      screen.queryByRole('button', { name: 'SKILL.md' })
    ).not.toBeInTheDocument();
    fireEvent.click(contentsFolder);
    const skillDocument = screen.getByRole('button', { name: 'SKILL.md' });
    fireEvent.click(skillDocument);
    expect(
      await screen.findByText('Create and modify DOCX artifacts.')
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
});
