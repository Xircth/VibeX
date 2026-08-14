import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { BackendTransportProvider } from '@/lib/transport';
import { PluginsPage } from './Plugins';

function renderPage(environment: BackendTransport['environment']) {
  const transport: BackendTransport = {
    environment,
    call: vi.fn().mockResolvedValue({ plugins: [], runtimes: [] }),
    capabilities: vi.fn().mockResolvedValue({
      server_version: 'test',
      protocol_version: '1.0',
      minimum_client_version: '0.1.0',
      capabilities: ['plugin.read'],
    }),
  };
  return render(
    <BackendTransportProvider transport={transport}>
      <MemoryRouter initialEntries={['/plugins']}>
        <PluginsPage />
      </MemoryRouter>
    </BackendTransportProvider>
  );
}

describe('PluginsPage', () => {
  it('renders the product catalog without a duplicate module toolbar', async () => {
    renderPage('desktop');
    expect(screen.getByRole('heading', { name: '插件' })).toBeVisible();
    expect(await screen.findByText('没有匹配的插件')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: '返回 Agent 设置' })
    ).not.toBeInTheDocument();
  });

  it.each(['web', 'remote-desktop'] as const)(
    'uses the same embedded settings content on %s',
    async (environment) => {
      renderPage(environment);
      expect(screen.getByRole('heading', { name: '插件' })).toBeVisible();
      expect(await screen.findByText('没有匹配的插件')).toBeVisible();
      expect(
        screen.queryByRole('button', { name: '返回项目列表' })
      ).not.toBeInTheDocument();
    }
  );
});
