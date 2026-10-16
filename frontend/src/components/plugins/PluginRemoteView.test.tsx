import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginContributionCatalogItem } from '@/lib/api/plugins';

const { surfaceTransport, backend, federation } = vi.hoisted(() => ({
  surfaceTransport: {
    load: vi.fn(),
    invoke: vi.fn(),
    revoke: vi.fn(),
  },
  backend: {
    call: vi.fn(),
  },
  federation: {
    loadPluginRemote: vi.fn(() =>
      Promise.reject(new Error('plugin_remote_timeout'))
    ),
    mountRemoteModule: vi.fn(),
  },
}));

vi.mock('@/lib/pluginFederation', () => ({
  parseRemoteRef: () => ({
    name: 'open_connector',
    entry: 'http://127.0.0.1:9/remoteEntry.js',
    module: './view',
  }),
  isHttpRemoteEntry: () => true,
  loadPluginRemote: federation.loadPluginRemote,
  retainPluginRemote: vi.fn(),
  mountRemoteModule: federation.mountRemoteModule,
  unloadPluginRemote: vi.fn(),
}));

vi.mock('@/components/plugins/AppSurfaceHost', () => ({
  AppSurfaceHost: () => <div data-testid="app-surface-fallback" />,
}));

vi.mock('@/lib/api/appSurfaceTransport', () => ({
  createBackendAppSurfaceTransport: () => surfaceTransport,
}));

vi.mock('@/lib/backendTransport', () => ({
  configuredBackendTransport: backend,
}));

import {
  PluginRemoteView,
  brokerSurfaceForStatusRemote,
} from './PluginRemoteView';

const item: PluginContributionCatalogItem = {
  pluginId: 'vibex.open-connector',
  id: 'console',
  kind: 'app_tab',
  label: 'Open Connector',
  generation: 1,
  metadata: {
    remote: {
      name: 'open_connector',
      entry: 'http://127.0.0.1:9/remoteEntry.js',
      module: './view',
    },
  },
};

const remote = {
  name: 'open_connector',
  entry: 'http://127.0.0.1:9/remoteEntry.js',
  module: './view',
};

const statusItem: PluginContributionCatalogItem = {
  pluginId: 'vibex.open-connector',
  id: 'computer-use-status',
  kind: 'status',
  label: '电脑控制',
  generation: 1,
  metadata: { remote, slot: 'status.after-mcp' },
};

describe('brokerSurfaceForStatusRemote', () => {
  it('prefers the settings page that publishes the same remote', () => {
    const broker = brokerSurfaceForStatusRemote(statusItem, [
      statusItem,
      {
        pluginId: 'someone-else',
        id: 'computer-use',
        kind: 'settings_page',
        label: 'Other',
        generation: 9,
        metadata: { remote },
      },
      {
        pluginId: statusItem.pluginId,
        id: 'other-view',
        kind: 'settings_page',
        label: 'Other view',
        generation: 4,
        metadata: { remote: { ...remote, module: './other' } },
      },
      {
        pluginId: statusItem.pluginId,
        id: 'console',
        kind: 'app_tab',
        label: 'Console',
        generation: 3,
        metadata: { remote },
      },
      {
        pluginId: statusItem.pluginId,
        id: 'computer-use',
        kind: 'settings_page',
        label: '电脑控制',
        generation: 7,
        metadata: { remote },
      },
    ]);
    expect(broker).toEqual({ surfaceId: 'computer-use', generation: 7 });
  });

  it('keeps the status id when no sibling shares the remote', () => {
    expect(brokerSurfaceForStatusRemote(statusItem, [statusItem])).toEqual({
      surfaceId: statusItem.id,
      generation: statusItem.generation,
    });
  });
});

describe('PluginRemoteView', () => {
  beforeEach(() => {
    surfaceTransport.load.mockReset();
    surfaceTransport.invoke.mockReset();
    surfaceTransport.revoke.mockReset();
    backend.call.mockReset();
    federation.loadPluginRemote.mockReset();
    federation.loadPluginRemote.mockImplementation(() =>
      Promise.reject(new Error('plugin_remote_timeout'))
    );
    federation.mountRemoteModule.mockReset();
  });

  it('falls back to the packaged app surface when the HTTP remote fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<PluginRemoteView item={item} slot="app.tab" />);
    expect(
      await screen.findByTestId('app-surface-fallback')
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('plugin-surface-placeholder')
    ).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('opens the sibling settings session for a status remote', async () => {
    backend.call.mockResolvedValue({
      generation: 7,
      items: [
        statusItem,
        {
          pluginId: statusItem.pluginId,
          id: 'computer-use',
          kind: 'settings_page',
          label: '电脑控制',
          generation: 7,
          metadata: { remote },
        },
      ],
    });
    surfaceTransport.load.mockResolvedValue({ token: 'a'.repeat(48) });
    federation.loadPluginRemote.mockResolvedValue({ default: () => null });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true })
    );
    render(<PluginRemoteView item={statusItem} slot="status.after-mcp" />);
    await waitFor(() => {
      expect(surfaceTransport.load).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: statusItem.pluginId,
          surfaceId: 'computer-use',
          generation: 7,
        })
      );
    });
    expect(backend.call).toHaveBeenCalledWith('plugin_contribution_catalog');
    expect(federation.mountRemoteModule).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        surfaceId: 'computer-use-status',
        slot: 'status.after-mcp',
      })
    );
    vi.unstubAllGlobals();
  });
});
