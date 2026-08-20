import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { BackendTransportProvider } from '@/lib/transport';
import { SettingsLayout } from './SettingsLayout';

describe('SettingsLayout capability gating', () => {
  it('keeps the settings shell pinned to the visible viewport', () => {
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(),
    };
    render(
      <BackendTransportProvider transport={transport}>
        <MemoryRouter initialEntries={['/settings/general']}>
          <Routes>
            <Route path="/settings" element={<SettingsLayout />}>
              <Route path="general" element={<div>General content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </BackendTransportProvider>
    );

    const shell = screen.getByText('General content').closest('.settings-page');
    expect(shell).toHaveClass('fixed', 'inset-0');
    expect(shell).not.toHaveClass('h-screen');
  });

  it('shows the Agent page skeleton while the settings chunk is loading', () => {
    const PendingAgentPage = lazy(() => new Promise<never>(() => undefined));
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(),
    };
    render(
      <BackendTransportProvider transport={transport}>
        <MemoryRouter initialEntries={['/settings/agents']}>
          <Routes>
            <Route path="/settings" element={<SettingsLayout />}>
              <Route path="agents" element={<PendingAgentPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </BackendTransportProvider>
    );

    const status = screen.getByRole('status', {
      name: /正在读取 Agent|Loading Agent/,
    });
    expect(status).toHaveClass('agent-settings-loading');
    expect(
      status.querySelectorAll('.agent-settings-loading-mark')
    ).toHaveLength(7);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows Web-supported product settings and hides desktop-only controls', async () => {
    const transport: BackendTransport = {
      environment: 'web',
      call: vi.fn(),
      capabilities: vi.fn().mockResolvedValue({
        server_version: '1.0.0',
        protocol_version: '1.0',
        minimum_client_version: '0.1.0',
        capabilities: [
          'plugin.read',
          'artifact.read',
          'automation.read',
          'delegation.read',
          'device.pair',
        ],
      }),
    };
    render(
      <BackendTransportProvider transport={transport}>
        <MemoryRouter initialEntries={['/settings/automations']}>
          <Routes>
            <Route path="/settings" element={<SettingsLayout />}>
              <Route
                path="automations"
                element={<div>Automation content</div>}
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </BackendTransportProvider>
    );

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /automations|自动化/i })
      ).toBeInTheDocument()
    );
    expect(
      screen.getByRole('button', { name: /plugins|插件/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /remote connection|远程连接/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^devices$|^设备$/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^agents?$|^Agent$/i })
    ).not.toBeInTheDocument();
  });

  it('shows Host coding settings when application.call is advertised', async () => {
    const transport: BackendTransport = {
      environment: 'web',
      call: vi.fn(),
      capabilities: vi.fn().mockResolvedValue({
        server_version: '1.0.0',
        protocol_version: '1.0',
        minimum_client_version: '0.1.0',
        capabilities: ['application.call', 'plugin.read', 'device.pair'],
      }),
    };
    render(
      <BackendTransportProvider transport={transport}>
        <MemoryRouter initialEntries={['/settings/appearance']}>
          <Routes>
            <Route path="/settings" element={<SettingsLayout />}>
              <Route path="appearance" element={<div>Appearance</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </BackendTransportProvider>
    );

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /agents?|智能体/i })
      ).toBeInTheDocument()
    );
    expect(
      screen.getByRole('button', { name: /general|常规/i })
    ).toBeInTheDocument();
  });

  it('opens Plugins as a top-level product module', async () => {
    const user = userEvent.setup();
    const transport: BackendTransport = {
      environment: 'web',
      call: vi.fn(),
      capabilities: vi.fn().mockResolvedValue({
        server_version: '1.0.0',
        protocol_version: '1.0',
        minimum_client_version: '0.1.0',
        capabilities: ['plugin.read'],
      }),
    };
    render(
      <BackendTransportProvider transport={transport}>
        <MemoryRouter initialEntries={['/settings/agents']}>
          <Routes>
            <Route path="/settings" element={<SettingsLayout />}>
              <Route path="agents" element={<div>Agent content</div>} />
            </Route>
            <Route path="/plugins" element={<div>Product plugins</div>} />
          </Routes>
        </MemoryRouter>
      </BackendTransportProvider>
    );

    await user.click(
      await screen.findByRole('button', { name: /plugins|插件/i })
    );

    expect(screen.getByText('Product plugins')).toBeInTheDocument();
    expect(screen.queryByText('Agent content')).not.toBeInTheDocument();
  });
});
