import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPluginCrashState,
  recordPluginCrash,
} from '@/components/plugins/PluginBoundary';
import type { BackendTransport } from '@/lib/backendTransport';
import { BackendTransportProvider } from '@/lib/transport';
import { getPluginVolatileConfig } from '@vibex/plugin-sdk';
import { PluginCatalogPage, PluginDetailPage } from './ProductPlugins';

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => ({ toast: toastMock }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn().mockResolvedValue(() => undefined),
  }),
}));

const basePlugin = {
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
  readme: '# VibeX Office\n\nOffice files in VibeX.',
  contents: [],
  config: { preview: true, idleTimeoutMinutes: 15 },
  configSchema: {
    type: 'object',
    properties: {
      preview: { type: 'boolean', title: 'Document preview' },
      idleTimeoutMinutes: {
        type: 'number',
        title: 'Idle timeout',
        minimum: 1,
      },
    },
  },
};

function renderRoute(
  initialEntry: string,
  call: BackendTransport['call'],
  capabilities = ['plugin.read', 'plugin.write']
) {
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
      capabilities,
    }),
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <BackendTransportProvider transport={transport}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/plugins" element={<PluginCatalogPage />} />
            <Route path="/plugins/:pluginId" element={<PluginDetailPage />} />
          </Routes>
        </MemoryRouter>
      </BackendTransportProvider>
    </QueryClientProvider>
  );
}

describe('Plugin Auto-Quarantine recovery and Volatile<T> hot config updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPluginCrashState();
  });

  it('shows quarantine badge and explicit recovery action in /plugins and recovers on click', async () => {
    const quarantinedPlugin = {
      ...basePlugin,
      id: 'crashy-worker',
      name: 'Crashy Worker',
      builtin: false,
      sourceKind: 'snapshot',
      enabled: false,
      quarantined: true,
      quarantineReason: (
        'Plugin "crashy-worker" automatically quarantined after 3 crashes within 60 seconds') as
        | string
        | null,
    };
    let currentCatalogPlugin = quarantinedPlugin;
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_control_catalog') {
        return { plugins: [currentCatalogPlugin], runtimes: [] };
      }
      if (command === 'plugin_check_updates') return [];
      if (command === 'plugin_control_set_enabled') {
        currentCatalogPlugin = {
          ...quarantinedPlugin,
          enabled: true,
          quarantined: false,
          quarantineReason: null,
        };
        return currentCatalogPlugin;
      }
      throw new Error(command);
    });

    renderRoute('/plugins', call);

    const row = (await screen.findByText('Crashy Worker')).closest(
      '.product-plugin-row'
    ) as HTMLElement;
    expect(row).not.toBeNull();
    expect(
      row.querySelector('[data-plugin-quarantined-badge="crashy-worker"]')
    ).not.toBeNull();
    expect(
      row.querySelector('[data-plugin-quarantine-reason="crashy-worker"]')
    ).toHaveTextContent(/automatically quarantined after 3 crashes/i);

    const recoverBtn = row.querySelector(
      '[data-plugin-recover="crashy-worker"]'
    ) as HTMLElement;
    expect(recoverBtn).toBeVisible();
    await waitFor(() => expect(recoverBtn).toBeEnabled());
    fireEvent.click(recoverBtn);

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('plugin_control_set_enabled', {
        pluginId: 'crashy-worker',
        enabled: true,
      })
    );
  });

  it('quarantines a plugin after consecutive UI ErrorBoundary crashes and allows recovery on the detail page', async () => {
    clearPluginCrashState('ui-crasher');
    recordPluginCrash('ui-crasher', new Error('Render boom 1'));
    recordPluginCrash('ui-crasher', new Error('Render boom 2'));
    recordPluginCrash('ui-crasher', new Error('Render boom 3'));

    const uiCrashPlugin = {
      ...basePlugin,
      id: 'ui-crasher',
      name: 'UI Crasher',
      builtin: false,
      sourceKind: 'snapshot',
      enabled: true,
    };
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_control_catalog') {
        return { plugins: [uiCrashPlugin], runtimes: [] };
      }
      if (command === 'plugin_product_detail') return detail;
      if (command === 'plugin_contribution_catalog') {
        return { generation: 1, items: [] };
      }
      if (command === 'plugin_control_set_enabled') {
        return { ...uiCrashPlugin, enabled: true, quarantined: false };
      }
      throw new Error(command);
    });

    renderRoute('/plugins/ui-crasher', call);

    const banner = await screen.findByTestId('plugin-quarantine-banner');
    expect(banner).toBeVisible();
    expect(banner).toHaveTextContent(/Render boom 3/i);

    const recoverBtn = within(banner).getByRole('button', {
      name: /解除隔离|Recover/i,
    });
    await waitFor(() => expect(recoverBtn).toBeEnabled());
    fireEvent.click(recoverBtn);

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('plugin_control_set_enabled', {
        pluginId: 'ui-crasher',
        enabled: true,
      })
    );
    clearPluginCrashState('ui-crasher');
  });

  it('pushes hot config updates into Volatile<T> when saving config on the detail page without generation rebuild', async () => {
    const volatileCell = getPluginVolatileConfig('office');
    const volatileSpy = vi.fn();
    const unsub = volatileCell.onChange(volatileSpy);

    const call = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'plugin_control_catalog') {
          return { plugins: [basePlugin], runtimes: [] };
        }
        if (command === 'plugin_product_detail') return detail;
        if (command === 'plugin_contribution_catalog') {
          return { generation: 1, items: [] };
        }
        if (command === 'plugin_save_config') {
          return {
            ...detail,
            config: (args?.config as Record<string, unknown>) ?? detail.config,
          };
        }
        throw new Error(command);
      }
    );

    renderRoute('/plugins/office', call);

    expect(
      (await screen.findAllByRole('heading', { name: 'VibeX Office' }))[0]
    ).toBeVisible();
    await waitFor(() =>
      expect(volatileCell.current).toEqual({
        preview: true,
        idleTimeoutMinutes: 15,
      })
    );

    fireEvent.click(screen.getByRole('tab', { name: /配置|config/i }));
    const timeoutInput = await screen.findByRole('spinbutton', {
      name: 'Idle timeout',
    });
    await waitFor(() => expect(timeoutInput).toBeEnabled());
    fireEvent.change(timeoutInput, { target: { value: '45' } });

    await waitFor(() =>
      expect(volatileCell.current).toEqual({
        preview: true,
        idleTimeoutMinutes: 45,
      })
    );
    expect(volatileSpy).toHaveBeenCalledWith(
      { preview: true, idleTimeoutMinutes: 45 },
      { preview: true, idleTimeoutMinutes: 15 }
    );
    unsub();
  });
});
