import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PluginContributionCatalogItem } from '@/lib/api/plugins';

vi.mock('@/lib/pluginFederation', () => ({
  parseRemoteRef: () => ({
    name: 'open_connector',
    entry: 'http://127.0.0.1:9/remoteEntry.js',
    module: './view',
  }),
  isHttpRemoteEntry: () => true,
  loadPluginRemote: () => Promise.reject(new Error('plugin_remote_timeout')),
  mountRemoteModule: vi.fn(),
  unloadPluginRemote: vi.fn(),
}));

vi.mock('@/components/plugins/AppSurfaceHost', () => ({
  AppSurfaceHost: () => <div data-testid="app-surface-fallback" />,
}));

vi.mock('@/lib/api/appSurfaceTransport', () => ({
  createBackendAppSurfaceTransport: () => ({}),
}));

vi.mock('@/lib/backendTransport', () => ({
  configuredBackendTransport: {},
}));

import { PluginRemoteView } from './PluginRemoteView';

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

describe('PluginRemoteView', () => {
  it('falls back to the packaged app surface when the HTTP remote fails', async () => {
    render(<PluginRemoteView item={item} slot="app.tab" />);
    expect(await screen.findByTestId('app-surface-fallback')).toBeInTheDocument();
    expect(
      screen.queryByTestId('plugin-surface-placeholder')
    ).not.toBeInTheDocument();
  });
});
