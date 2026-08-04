import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSettings } from './AgentSettings';

const api = vi.hoisted(() => ({
  bar: vi.fn(),
  registry: vi.fn(),
  refreshRegistry: vi.fn(),
  addAndInstall: vi.fn(),
  setEnabled: vi.fn(),
  reorder: vi.fn(),
  preflight: vi.fn(),
  repair: vi.fn(),
  update: vi.fn(),
  rollback: vi.fn(),
  cancelOperation: vi.fn(),
  uninstall: vi.fn(),
  remove: vi.fn(),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  diagnostics: vi.fn(),
  clearDiagnostics: vi.fn(),
}));

vi.mock('@/features/agent-management/api', () => ({
  agentManagementApi: api,
}));

vi.mock('@/lib/tauriApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/tauriApi')>();
  return { ...original, tauriListen: vi.fn().mockResolvedValue(vi.fn()) };
});

describe('AgentSettings', () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    api.bar.mockResolvedValue([
      {
        agent_id: 'codex',
        display_name: 'Codex',
        description: 'Codex ACP',
        icon_light: null,
        icon_dark: null,
        icon_svg: null,
        source: 'built_in_profile',
        built_in: true,
        retired: false,
        enabled: true,
        position: 0,
        lifecycle: 'ready',
        authentication: 'account',
        runtime_version: '1.0.0',
        acp_version: '1.0.0',
        active_operation: null,
        rollback_available: false,
      },
    ]);
    api.readConfig.mockResolvedValue({
      agent_id: 'codex',
      available: false,
      path: null,
      fields: [],
      applies_to_next_session: true,
    });
    api.diagnostics.mockResolvedValue([]);
  });

  it('renders the management projection as the only Agent settings source', async () => {
    render(<AgentSettings />);
    expect(await screen.findByRole('button', { name: 'Codex' })).toBeVisible();
    await waitFor(() => expect(api.readConfig).toHaveBeenCalledWith('codex'));
    expect(screen.getByText('已通过账号登录')).toBeInTheDocument();
  });

  it('lets the user install an added Agent when preflight finds no valid installation', async () => {
    const user = userEvent.setup();
    api.bar.mockResolvedValue([
      {
        agent_id: 'kimi',
        display_name: 'Kimi CLI',
        description: "Moonshot AI's coding assistant",
        icon_light: null,
        icon_dark: null,
        icon_svg: null,
        source: 'official_registry',
        built_in: false,
        retired: false,
        enabled: true,
        position: 0,
        lifecycle: 'uninstalled',
        authentication: 'not_required',
        runtime_version: null,
        acp_version: null,
        active_operation: null,
        rollback_available: false,
      },
    ]);
    api.readConfig.mockResolvedValue({
      agent_id: 'kimi',
      available: false,
      path: null,
      fields: [],
      applies_to_next_session: true,
    });
    api.preflight.mockResolvedValue({
      agent_id: 'kimi',
      checked_at: '2026-08-04T00:00:00Z',
      items: [
        {
          id: 'membership',
          label: '运行入口',
          status: 'pass',
          detail: 'Agent 已加入本地列表。',
          version: null,
          path: null,
          repairable: false,
        },
        {
          id: 'runtime',
          label: '本地 Runtime',
          status: 'fail',
          detail: '未发现有效的当前安装锁。',
          version: null,
          path: null,
          repairable: true,
        },
        {
          id: 'acp',
          label: 'ACP 适配器',
          status: 'fail',
          detail: '未通过 ACP 探测。',
          version: null,
          path: null,
          repairable: true,
        },
      ],
    });
    api.addAndInstall.mockResolvedValue({
      operation_id: 'install-kimi',
      agent_id: 'kimi',
      kind: 'install',
      status: 'queued',
    });

    render(<AgentSettings />);
    await screen.findByRole('button', { name: 'Kimi CLI' });
    await user.click(screen.getByRole('button', { name: '立即检查' }));

    await user.click(
      await screen.findByRole('button', { name: '安装 Runtime 与 ACP' })
    );
    expect(api.addAndInstall).toHaveBeenCalledWith('kimi');
  });
});
