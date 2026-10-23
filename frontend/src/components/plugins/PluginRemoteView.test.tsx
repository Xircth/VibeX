import { createPluginContext, disposePluginRegistrations } from '@vibex/plugin-sdk';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginContributionCatalogItem } from '@/lib/api/plugins';

vi.mock('@/components/plugins/AppSurfaceHost', () => ({
  AppSurfaceHost: () => <div data-testid="app-surface-fallback" />,
}));

import { PluginRemoteView } from './PluginRemoteView';

const item: PluginContributionCatalogItem = {
  pluginId: 'vibex.open-connector',
  id: 'console',
  kind: 'app_tab',
  label: 'Open Connector',
  generation: 1,
  metadata: {},
};

describe('PluginRemoteView', () => {
  afterEach(() => {
    disposePluginRegistrations(item.pluginId);
  });

  it('renders a registered v2 in-process view component directly', () => {
    const ctx = createPluginContext({ pluginId: item.pluginId });
    ctx.ui.registerTab({
      id: 'console',
      title: 'Open Connector',
      component: ({ surfaceId }: { surfaceId?: string }) => (
        <div data-testid="v2-console-view">Surface:{surfaceId}</div>
      ),
    });

    render(<PluginRemoteView item={item} slot="app.tab" />);
    expect(screen.getByTestId('plugin-remote-view')).toBeInTheDocument();
    expect(screen.getByTestId('v2-console-view')).toHaveTextContent(
      'Surface:console'
    );
  });

  it('falls back to AppSurfaceHost when no in-process view is registered', () => {
    render(<PluginRemoteView item={item} slot="app.tab" />);
    expect(screen.getByTestId('app-surface-fallback')).toBeInTheDocument();
  });

  it('renders disabled placeholder when enabled is false', () => {
    render(<PluginRemoteView item={item} slot="app.tab" enabled={false} />);
    expect(
      screen.getByTestId('plugin-surface-placeholder')
    ).toBeInTheDocument();
  });
});
