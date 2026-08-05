import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { PluginsSettings } from './PluginsSettings';

function LocationProbe() {
  const location = useLocation();
  return (
    <output aria-label="Current location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function renderSettings(
  transport: BackendTransport,
  { showLocation = false }: { showLocation?: boolean } = {}
) {
  return render(
    <MemoryRouter initialEntries={['/settings/plugins']}>
      <PluginsSettings transport={transport} />
      {showLocation ? <LocationProbe /> : null}
    </MemoryRouter>
  );
}

describe('PluginsSettings', () => {
  it('shows enabled, dependency, skill, and provider readiness separately', async () => {
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_action_catalog') {
        return {
          plugin: {
            id: 'vibex.office',
            name: 'VibeX Office',
            version: '2.0.0',
            membership: 'builtin',
          },
          actions: [],
          readiness: {
            enabled: true,
            dependency: {
              id: 'officecli',
              status: 'ready',
              version: '1.0.140',
            },
            skills: [
              { id: 'office-pptx', status: 'ready' },
              { id: 'office-docx', status: 'ready' },
              { id: 'office-xlsx', status: 'ready' },
            ],
            providers: [{ id: 'officecli', status: 'ready' }],
            overall: 'ready',
          },
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    renderSettings(transport);

    expect(await screen.findByText('VibeX Office')).toBeVisible();
    expect(screen.getByText('添加更多能力支持')).toBeVisible();
    expect(
      screen.queryByText(/manifest|固定版本|哈希|安装命令/)
    ).not.toBeInTheDocument();
    expect(screen.getByText('已启用')).toBeVisible();
    expect(screen.getByText('依赖 · officecli')).toBeVisible();
    expect(screen.getByText('1.0.140 · 就绪')).toBeVisible();
    expect(screen.getByText('技能 · office-pptx')).toBeVisible();
    expect(screen.getByText('Provider · officecli')).toBeVisible();
  });

  it('does not load or render the removed legacy plugin settings', async () => {
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_action_catalog') {
        return {
          plugin: {
            id: 'vibex.office',
            name: 'VibeX Office',
            version: '2.0.0',
            membership: 'builtin',
          },
          actions: [],
          readiness: {
            enabled: false,
            dependency: { id: 'officecli', status: 'missing' },
            skills: [],
            providers: [],
            overall: 'not_ready',
          },
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    renderSettings(transport);

    expect(await screen.findByText('VibeX Office')).toBeVisible();
    expect(screen.queryByText('Old PPT Plugin')).not.toBeInTheDocument();
    expect(screen.queryByText('Mapped builtin')).not.toBeInTheDocument();
    expect(screen.queryByText('migration_required')).not.toBeInTheDocument();
    expect(screen.queryByText(/旧安装命令不会执行/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: /安装命令/ })
    ).not.toBeInTheDocument();
  });

  it('exposes cancellation for the managed enable install attempt', async () => {
    const user = userEvent.setup();
    const catalog = {
      plugin: {
        id: 'vibex.office',
        name: 'VibeX Office',
        version: '2.0.0',
        membership: 'builtin',
      },
      actions: [],
      readiness: {
        enabled: false,
        dependency: { id: 'officecli', status: 'missing' },
        skills: [],
        providers: [],
        overall: 'not_ready',
      },
    };
    let finishEnable: ((value: unknown) => void) | undefined;
    let enableTaskId = '';
    const call = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'plugin_action_catalog') return catalog;
        if (command === 'office_plugin_set_enabled') {
          enableTaskId = String(args?.taskId);
          return new Promise((resolve) => {
            finishEnable = resolve;
          });
        }
        if (command === 'officecli_cancel_install') {
          expect(args?.taskId).toBe(enableTaskId);
          finishEnable?.(catalog);
          return true;
        }
        throw new Error(`unexpected command: ${command}`);
      }
    );
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    renderSettings(transport);
    await user.click(
      await screen.findByRole('switch', { name: '启用 VibeX Office' })
    );
    await user.click(screen.getByRole('button', { name: '取消启用与安装' }));

    expect(call).toHaveBeenCalledWith('officecli_cancel_install', {
      taskId: enableTaskId,
    });
  });

  it('offers to apply plugin skills to every agent after enabling', async () => {
    const user = userEvent.setup();
    const disabledCatalog = {
      plugin: {
        id: 'vibex.office',
        name: 'VibeX Office',
        version: '2.0.0',
        membership: 'builtin',
      },
      actions: [],
      readiness: {
        enabled: false,
        dependency: { id: 'officecli', status: 'missing' },
        skills: [
          { id: 'office-pptx', status: 'ready' },
          { id: 'office-docx', status: 'ready' },
          { id: 'office-xlsx', status: 'ready' },
        ],
        providers: [{ id: 'officecli', status: 'unavailable' }],
        overall: 'not_ready',
      },
    };
    const enabledCatalog = {
      ...disabledCatalog,
      readiness: {
        ...disabledCatalog.readiness,
        enabled: true,
        dependency: {
          id: 'officecli',
          status: 'ready',
          version: '1.0.140',
        },
        providers: [{ id: 'officecli', status: 'ready' }],
        overall: 'ready',
      },
    };
    let catalog = disabledCatalog;
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_action_catalog') return catalog;
      if (command === 'office_plugin_set_enabled') {
        catalog = enabledCatalog;
        return enabledCatalog;
      }
      if (command === 'plugin_skills_configure') return [];
      throw new Error(`unexpected command: ${command}`);
    });
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    renderSettings(transport);
    await user.click(
      await screen.findByRole('switch', { name: '启用 VibeX Office' })
    );

    const setupDialog = await screen.findByRole('dialog', {
      name: '为 Agent 配置插件技能',
    });
    expect(setupDialog).toBeVisible();
    expect(
      within(setupDialog)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['前往 Skill 设置', '应用到所有 Agent']);
    expect(screen.getByText('office-pptx')).toBeVisible();
    expect(screen.getByText('office-docx')).toBeVisible();
    expect(screen.getByText('office-xlsx')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '应用到所有 Agent' }));

    expect(call).toHaveBeenCalledWith('plugin_skills_configure', {
      pluginId: 'vibex.office',
      apps: [],
      allAgents: true,
      link: false,
    });
    expect(
      screen.queryByRole('dialog', { name: '为 Agent 配置插件技能' })
    ).not.toBeInTheDocument();
  });

  it('opens the plugin assignment flow on the Skill settings page', async () => {
    const user = userEvent.setup();
    const disabledCatalog = {
      plugin: {
        id: 'vibex.office',
        name: 'VibeX Office',
        version: '2.0.0',
        membership: 'builtin',
      },
      actions: [],
      readiness: {
        enabled: false,
        dependency: { id: 'officecli', status: 'missing' },
        skills: [{ id: 'office-pptx', status: 'ready' }],
        providers: [],
        overall: 'not_ready',
      },
    };
    const enabledCatalog = {
      ...disabledCatalog,
      readiness: {
        ...disabledCatalog.readiness,
        enabled: true,
        dependency: { id: 'officecli', status: 'ready' },
        overall: 'ready',
      },
    };
    let catalog = disabledCatalog;
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_action_catalog') return catalog;
      if (command === 'office_plugin_set_enabled') {
        catalog = enabledCatalog;
        return enabledCatalog;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const transport: BackendTransport = { environment: 'desktop', call };

    renderSettings(transport, { showLocation: true });
    await user.click(
      await screen.findByRole('switch', { name: '启用 VibeX Office' })
    );
    await user.click(
      await screen.findByRole('button', { name: '前往 Skill 设置' })
    );

    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      '/settings/skills?plugin=vibex.office'
    );
  });
});
