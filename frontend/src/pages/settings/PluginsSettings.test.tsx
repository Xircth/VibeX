import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { PluginsSettings } from './PluginsSettings';

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
      if (command === 'plugin_legacy_migration_list') {
        return [];
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    render(<PluginsSettings transport={transport} />);

    expect(await screen.findByText('VibeX Office')).toBeVisible();
    expect(screen.getByText('已启用')).toBeVisible();
    expect(screen.getByText('依赖 · officecli')).toBeVisible();
    expect(screen.getByText('1.0.140 · 就绪')).toBeVisible();
    expect(screen.getByText('技能 · office-pptx')).toBeVisible();
    expect(screen.getByText('Provider · officecli')).toBeVisible();
  });

  it('marks legacy plugins for migration without exposing install commands', async () => {
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
      if (command === 'plugin_legacy_migration_list') {
        return [
          {
            legacyPluginId: 'legacy-1',
            name: 'Old PPT Plugin',
            status: 'migration_required',
            mappedPluginId: null,
          },
          {
            legacyPluginId: 'legacy-builtin',
            name: 'Mapped builtin',
            status: 'mapped_builtin',
            mappedPluginId: 'vibex.builtin.dashi-ppt',
          },
        ];
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    render(<PluginsSettings transport={transport} />);

    expect(await screen.findByText('Old PPT Plugin')).toBeVisible();
    expect(screen.queryByText('Mapped builtin')).not.toBeInTheDocument();
    expect(screen.getByText('migration_required')).toBeVisible();
    expect(screen.getByText(/旧安装命令不会执行/)).toBeVisible();
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
        if (command === 'plugin_legacy_migration_list') return [];
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

    render(<PluginsSettings transport={transport} />);
    await user.click(
      await screen.findByRole('switch', { name: '启用 VibeX Office' })
    );
    await user.click(screen.getByRole('button', { name: '取消启用与安装' }));

    expect(call).toHaveBeenCalledWith('officecli_cancel_install', {
      taskId: enableTaskId,
    });
  });
});
