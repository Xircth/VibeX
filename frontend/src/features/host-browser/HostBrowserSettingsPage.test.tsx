import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { HostBrowserSettingsPage } from './HostBrowserSettingsPage';
import { resetBrowserPrefsForTests } from './browserPrefsStore';

const backendCall = vi.hoisted(() => vi.fn());

vi.mock('@/lib/backendTransport', () => ({
  backendCall,
  backendListen: vi.fn(async () => () => {}),
}));

describe('HostBrowserSettingsPage', () => {
  beforeEach(() => {
    backendCall.mockReset();
    resetBrowserPrefsForTests();
    backendCall.mockImplementation(
      async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'plugin_get_product_detail') {
          return { config: {} };
        }
        if (cmd === 'plugin_invoke_contribution') {
          const input = args?.input as
            | { operation?: string; input?: Record<string, unknown> }
            | undefined;
          if (input?.operation === 'capabilities') {
            return {
              available: true,
              platform: 'windows',
              surface: 'child',
              profiles: true,
              docGuest: true,
              proxy: {
                supported: true,
                active: null,
                source: 'system',
                note: 'Inherited from system proxy',
              },
              downloadsDir: 'C:\\Users\\test\\Downloads',
              policy: {
                source: 'file',
                enabled: true,
                path: 'C:\\ProgramData\\VibeX\\browser-policy.json',
                managedRules: [
                  { pattern: '*.corp.internal', action: 'system' },
                ],
                rulesCount: 1,
              },
            };
          }
          if (input?.operation === 'settings.set') {
            return input.input ?? {};
          }
          if (input?.operation === 'profile.create') {
            return { id: 'work', label: 'work' };
          }
        }
        return {};
      }
    );
  });

  it('renders browser settings sections and policy rules', async () => {
    render(<HostBrowserSettingsPage pluginId="test.browser" />);

    expect(await screen.findByText('链接打开方式')).toBeInTheDocument();
    expect(screen.getByText('配置与站点规则')).toBeInTheDocument();
    expect(screen.getByText('配置文件')).toBeInTheDocument();
    expect(screen.getByText('站点规则')).toBeInTheDocument();
    expect(screen.getByText('Agent 浏览器控制 (MCP)')).toBeInTheDocument();
    expect(screen.getByText('运行环境与渲染')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('*.corp.internal')).toBeInTheDocument();
      expect(
        screen.getByText('C:\\Users\\test\\Downloads')
      ).toBeInTheDocument();
    });
  });

  it('validates and adds a site rule and persists to backend', async () => {
    const user = userEvent.setup();
    render(<HostBrowserSettingsPage pluginId="test.browser" />);

    const input = await screen.findByPlaceholderText(
      /例如 \*\.corp\.internal/i
    );
    await user.type(input, 'https://bad.example.com/with/path{enter}');
    expect(
      await screen.findByRole('alert')
    ).toHaveTextContent(/不支持路径/);

    await user.clear(input);
    await user.type(input, '*.internal.dev{enter}');

    expect(await screen.findByText('*.internal.dev')).toBeInTheDocument();
    await waitFor(() => {
      expect(backendCall).toHaveBeenCalledWith(
        'plugin_save_config',
        expect.objectContaining({
          pluginId: 'test.browser',
          config: expect.objectContaining({
            hostRules: [{ pattern: '*.internal.dev', action: 'system' }],
          }),
        })
      );
    });
  });

  it('creates a new browser profile via browser.dispatch', async () => {
    const user = userEvent.setup();
    render(<HostBrowserSettingsPage pluginId="test.browser" />);

    const profileInput = await screen.findByPlaceholderText(
      /配置文件名称，例如「工作」/i
    );
    await user.type(profileInput, 'work-profile{enter}');

    await waitFor(() => {
      expect(backendCall).toHaveBeenCalledWith('plugin_invoke_contribution', {
        pluginId: 'test.browser',
        handler: 'browser.dispatch',
        input: {
          operation: 'profile.create',
          input: { label: 'work-profile' },
        },
      });
    });
  });
});
