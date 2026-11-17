import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from '@/components/ui/toast';
import {
  recordAgentAcpUpdateCheck,
  resetAgentAcpUpdatesForTests,
} from '@/features/agent-management/agentAcpUpdates';
import { renderWithQueryClient as render } from '@/test/QueryClientHarness';

import { AgentSettings } from './AgentSettings';
import { resetAgentSettingsHarness } from './agentSettingsTestHarness';

const api = vi.hoisted(() => ({
  bar: vi.fn(),
  registry: vi.fn(),
  refreshRegistry: vi.fn(),
  addAndInstall: vi.fn(),
  addUserDefinitionAndInstall: vi.fn(),
  userDefinition: vi.fn(),
  updateUserDefinition: vi.fn(),
  setEnabled: vi.fn(),
  reorder: vi.fn(),
  preflight: vi.fn(),
  repair: vi.fn(),
  update: vi.fn(),
  checkUpdate: vi.fn(),
  applyUpdate: vi.fn(),
  rollback: vi.fn(),
  cancelOperation: vi.fn(),
  uninstall: vi.fn(),
  remove: vi.fn(),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  writeConfigFile: vi.fn(),
  diagnostics: vi.fn(),
  markDiagnosticsRead: vi.fn(),
  actions: vi.fn(),
  runAction: vi.fn(),
  accountFlow: vi.fn(),
  authMode: vi.fn(),
  setAuthMode: vi.fn(),
  environment: vi.fn(),
  dshProviders: vi.fn(),
  dshPlugins: vi.fn(),
  grokPlugins: vi.fn(),
  piPlugins: vi.fn(),
  piConfiguration: vi.fn(),
  piTrustEntries: vi.fn(),
  validatePiCommand: vi.fn(),
  modelProviders: vi.fn(),
  saveModelProvider: vi.fn(),
  bindModelProvider: vi.fn(),
  connectOpenCodeProvider: vi.fn(),
  clearDiagnostics: vi.fn(),
}));
const confirmShow = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Map<string, (event: unknown) => void>());
const tauriListeners = vi.hoisted(
  () => new Map<string, (event: unknown) => void>()
);
const tauriInvokeMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const redeemImportTicketMock = vi.hoisted(() => vi.fn());
const userSystem = vi.hoisted(() => ({
  config: {
    executor_profile: { executor: 'codex', variant: null as string | null },
  },
  loading: false,
  updateAndSaveConfig: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => userSystem,
}));

vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: { show: confirmShow },
}));

vi.mock('@/features/agent-management/api', () => ({
  agentManagementApi: api,
}));

vi.mock('@/features/model-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/model-router')>();
  return {
    ...actual,
    accountApi: {
      ...actual.accountApi,
      redeemImportTicket: redeemImportTicketMock,
    },
  };
});

vi.mock('./PluginsSettings', () => ({
  PluginsSettings: ({ ecosystem }: { ecosystem: string }) => (
    <section aria-label={`${ecosystem} native plugins`}>
      Native plugin manager
    </section>
  ),
}));

vi.mock('@/lib/tauriApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/tauriApi')>();
  return {
    ...original,
    tauriInvoke: tauriInvokeMock,
    tauriListen: vi.fn(
      async (event: string, listener: (event: unknown) => void) => {
        tauriListeners.set(event, listener);
        return vi.fn();
      }
    ),
  };
});

vi.mock('@/lib/backendTransport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/backendTransport')>();
  return {
    ...actual,
    backendListen: vi.fn(
      async (event: string, listener: (event: unknown) => void) => {
        listeners.set(event, listener);
        return vi.fn();
      }
    ),
  };
});

describe('AgentSettings (provisioning, preflight & updates)', () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    resetAgentAcpUpdatesForTests();
  });

  beforeEach(() => {
    resetAgentSettingsHarness({
      api,
      confirmShow,
      listeners,
      tauriListeners,
      tauriInvokeMock,
      redeemImportTicketMock,
      userSystem,
    });
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
      settings_features: [],
      path: null,
      paths: [],
      fields: [],
      files: [],
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
          source: null,
          repairable: false,
          update_available: false,
          available_version: null,
          update_group: null,
        },
        {
          id: 'runtime',
          label: '本地 Runtime',
          status: 'fail',
          detail: '未发现有效的当前安装锁。',
          version: null,
          path: null,
          source: null,
          repairable: true,
          update_available: false,
          available_version: null,
          update_group: null,
        },
        {
          id: 'acp',
          label: 'ACP 适配器',
          status: 'fail',
          detail: '未通过 ACP 探测。',
          version: null,
          path: null,
          source: null,
          repairable: true,
          update_available: false,
          available_version: null,
          update_group: null,
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

    await user.click(await screen.findByRole('button', { name: '安装 ACP' }));
    await user.click(await screen.findByRole('button', { name: '安装最新版' }));
    expect(api.addAndInstall).toHaveBeenCalledWith('kimi');
  });

  describe('enabling an Agent', () => {
    const kimi = {
      agent_id: 'kimi',
      display_name: 'Kimi CLI',
      description: "Moonshot AI's coding assistant",
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      source: 'official_registry',
      built_in: false,
      retired: false,
      enabled: false,
      position: 0,
      lifecycle: 'ready',
      authentication: 'not_required',
      runtime_version: null,
      acp_version: '1.0.0',
      active_operation: null,
      rollback_available: false,
    };
    const acpItem = (overrides: Record<string, unknown>) => ({
      id: 'acp',
      label: 'ACP 适配器',
      status: 'pass',
      detail: '',
      version: '1.0.0',
      path: null,
      source: null,
      repairable: false,
      update_available: false,
      available_version: null,
      update_group: null,
      ...overrides,
    });
    const arrange = (
      agent: Record<string, unknown>,
      acp: Record<string, unknown>,
      update: Record<string, unknown> = {}
    ) => {
      api.bar.mockResolvedValue([agent]);
      api.setEnabled.mockResolvedValue({ ...agent, enabled: true });
      api.readConfig.mockResolvedValue({
        agent_id: 'kimi',
        available: false,
        settings_features: [],
        path: null,
        paths: [],
        fields: [],
        files: [],
        applies_to_next_session: true,
      });
      api.preflight.mockResolvedValue({
        agent_id: 'kimi',
        checked_at: '2026-10-09T00:00:00Z',
        items: [acpItem(acp)],
      });
      api.checkUpdate.mockResolvedValue({
        agent_id: 'kimi',
        current_version: '1.0.0',
        available_version: null,
        update_available: false,
        snapshot_id: null,
        fetched_at: null,
        fresh: true,
        ...update,
      });
      const receipt = (kind: string) => ({
        operation_id: `${kind}-kimi`,
        agent_id: 'kimi',
        kind,
        status: 'queued',
      });
      api.addAndInstall.mockResolvedValue(receipt('install'));
      api.repair.mockResolvedValue(receipt('repair'));
      api.applyUpdate.mockResolvedValue(receipt('update'));
    };
    const enable = async () => {
      const user = userEvent.setup();
      await screen.findByRole('button', { name: 'Kimi CLI' });
      await waitFor(() => expect(api.preflight).toHaveBeenCalled());
      api.preflight.mockClear();
      await user.click(screen.getByRole('switch', { name: '启用 Agent' }));
    };

    it('checks and installs the ACP of an uninstalled Agent', async () => {
      arrange(
        { ...kimi, lifecycle: 'uninstalled', acp_version: null },
        { status: 'fail', repairable: true, version: null }
      );
      render(<AgentSettings />);
      await enable();

      await waitFor(() =>
        expect(api.addAndInstall).toHaveBeenCalledWith('kimi')
      );
      expect(api.setEnabled).toHaveBeenCalledWith('kimi', true);
      expect(api.preflight).toHaveBeenCalledWith('kimi');
    });

    it('immediately displays the 6-stage ACP progress bar when enabling an Agent', async () => {
      const user = userEvent.setup();
      arrange(
        { ...kimi, lifecycle: 'uninstalled', acp_version: null },
        { status: 'fail', repairable: true, version: null }
      );
      let resolveSetEnabled!: (value: unknown) => void;
      api.setEnabled.mockReturnValue(
        new Promise((resolve) => {
          resolveSetEnabled = resolve;
        })
      );
      render(<AgentSettings />);
      await screen.findByRole('button', { name: 'Kimi CLI' });
      await waitFor(() => expect(api.preflight).toHaveBeenCalled());
      api.preflight.mockClear();

      await user.click(screen.getByRole('switch', { name: '启用 Agent' }));

      const stagesList = await screen.findByRole('list', {
        name: '操作阶段',
      });
      expect(stagesList).toBeVisible();
      expect(stagesList).toHaveTextContent('基础环境检查');
      expect(stagesList).toHaveTextContent('ACP检查');
      expect(stagesList).toHaveTextContent('安装准备');
      expect(stagesList).toHaveTextContent('安装');
      expect(stagesList).toHaveTextContent('验证');
      expect(stagesList).toHaveTextContent('完成');

      await act(async () => {
        resolveSetEnabled({
          ...kimi,
          enabled: true,
          lifecycle: 'uninstalled',
          acp_version: null,
        });
      });

      await waitFor(() =>
        expect(api.addAndInstall).toHaveBeenCalledWith('kimi')
      );
    });

    it('repairs an installation the preflight finds broken', async () => {
      arrange(
        { ...kimi, lifecycle: 'needs_repair' },
        { status: 'fail', repairable: true }
      );
      render(<AgentSettings />);
      await enable();

      await waitFor(() => expect(api.repair).toHaveBeenCalledWith('kimi'));
      expect(api.addAndInstall).not.toHaveBeenCalled();
    });

    it('updates the ACP when the check finds a newer version', async () => {
      arrange(
        kimi,
        {},
        {
          available_version: '1.2.0',
          acp_available: '1.2.0',
          acp_current: '1.0.0',
          update_available: true,
        }
      );
      render(<AgentSettings />);
      await enable();

      await waitFor(() => expect(api.applyUpdate).toHaveBeenCalledWith('kimi'));
      expect(api.addAndInstall).not.toHaveBeenCalled();
      expect(api.repair).not.toHaveBeenCalled();
    });

    it('leaves a healthy up-to-date Agent alone', async () => {
      arrange(kimi, {});
      render(<AgentSettings />);
      await enable();

      await waitFor(() => expect(api.preflight).toHaveBeenCalledWith('kimi'));
      await waitFor(() => expect(api.checkUpdate).toHaveBeenCalled());
      expect(api.addAndInstall).not.toHaveBeenCalled();
      expect(api.repair).not.toHaveBeenCalled();
      expect(api.applyUpdate).not.toHaveBeenCalled();
    });

    it('does not install anything when the user disables an Agent', async () => {
      const user = userEvent.setup();
      arrange({ ...kimi, enabled: true, lifecycle: 'uninstalled' }, {});
      api.setEnabled.mockResolvedValue({
        ...kimi,
        enabled: false,
        lifecycle: 'uninstalled',
      });
      render(<AgentSettings />);
      await screen.findByRole('button', { name: 'Kimi CLI' });
      await waitFor(() => expect(api.preflight).toHaveBeenCalled());
      api.preflight.mockClear();
      api.addAndInstall.mockClear();

      await user.click(screen.getByRole('switch', { name: '启用 Agent' }));
      await user.click(await screen.findByRole('button', { name: '仅关闭' }));

      await waitFor(() =>
        expect(api.setEnabled).toHaveBeenCalledWith('kimi', false)
      );
      expect(api.preflight).not.toHaveBeenCalled();
      expect(api.addAndInstall).not.toHaveBeenCalled();
    });
  });

  it('runs a local preflight for the selected Agent immediately', async () => {
    const loggedOut = {
      agent_id: 'codex',
      display_name: 'Codex',
      description: 'OpenAI Codex (official native app-server engine)',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      source: 'built_in_profile',
      built_in: true,
      retired: false,
      enabled: true,
      position: 0,
      lifecycle: 'needs_auth',
      authentication: 'not_logged_in',
      runtime_version: '0.169.0',
      acp_version: '0.169.0',
      active_operation: null,
      rollback_available: false,
      settings_features: ['authentication_mode'],
    };
    const loggedIn = {
      ...loggedOut,
      lifecycle: 'ready',
      authentication: 'account',
    };
    let authenticated = false;
    api.bar.mockImplementation(async () => [
      authenticated ? loggedIn : loggedOut,
    ]);
    const item = {
      source: null,
      repairable: false,
      update_available: false,
      available_version: null,
      update_group: null,
    };
    api.preflight.mockImplementation(async (agentId: string) => {
      authenticated = true;
      return {
        agent_id: agentId,
        checked_at: '2026-08-22T00:00:00Z',
        items: [
          {
            ...item,
            id: 'native_runtime',
            label: '原生引擎运行时',
            status: 'pass',
            detail: '',
            version: '0.169.0',
            path: '/usr/local/bin/codex',
          },
          {
            ...item,
            id: 'auth.mode',
            label: '鉴权模式',
            status: 'pass',
            detail: 'ChatGPT 订阅模式已检测到有效账号会话。',
            version: 'chatgpt_subscription',
            path: '/tmp/.codex/auth.json',
          },
        ],
      };
    });

    render(<AgentSettings />);

    expect(await screen.findByText('暂未登录')).toBeVisible();
    await waitFor(() => expect(api.preflight).toHaveBeenCalledWith('codex'));
    expect(await screen.findByText('已通过账号登录')).toBeVisible();
    expect(await screen.findByText('未获得有效用户信息')).toBeVisible();
    expect(api.preflight.mock.calls[0]).toEqual(['codex']);
  });

  it('applies a background update check after local preflight without blocking the list', async () => {
    api.preflight.mockResolvedValue({
      agent_id: 'codex',
      checked_at: '2026-08-22T00:00:00Z',
      items: [
        {
          id: 'runtime',
          label: '本地 Runtime',
          status: 'pass',
          detail: '',
          version: '0.168.0',
          path: '/usr/local/bin/codex',
          source: null,
          repairable: false,
          update_available: false,
          available_version: null,
          update_group: null,
        },
        {
          id: 'native_runtime',
          label: '原生引擎运行时',
          status: 'pass',
          detail: '',
          version: '0.168.0',
          path: '/usr/local/bin/codex',
          source: null,
          repairable: false,
          update_available: false,
          available_version: null,
          update_group: null,
        },
      ],
    });
    let finishUpdate: (value: unknown) => void = () => undefined;
    api.checkUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpdate = resolve;
        })
    );

    render(<AgentSettings />);
    await waitFor(() => expect(api.preflight).toHaveBeenCalledWith('codex'));
    expect(await screen.findByTitle('0.168.0')).toBeInTheDocument();
    expect(screen.queryByText('本地 Runtime')).not.toBeInTheDocument();
    expect(screen.queryByText('可更新')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '立即检查' })
    ).not.toHaveAttribute('disabled');
    await waitFor(() => expect(api.checkUpdate).toHaveBeenCalledWith('codex'));

    await act(async () => {
      finishUpdate({
        agent_id: 'codex',
        current_version: '0.168.0',
        available_version: '0.169.0',
        update_available: true,
        runtime_current: '0.168.0',
        runtime_available: '0.169.0',
        acp_current: null,
        acp_available: null,
        snapshot_id: null,
        fetched_at: null,
        fresh: true,
      });
    });

    await waitFor(() => expect(screen.getAllByText('可更新')).toHaveLength(1));
  });

  it('marks native runtime as updatable when npm latest is newer than the probed CLI', async () => {
    api.preflight.mockResolvedValue({
      agent_id: 'codex',
      checked_at: '2026-09-09T00:00:00Z',
      items: [
        {
          id: 'native_runtime',
          label: '原生引擎运行时',
          status: 'pass',
          detail: '',
          version: '@openai/codex 0.168.0',
          path: '/usr/local/bin/codex',
          source: null,
          repairable: false,
          update_available: false,
          available_version: null,
          update_group: null,
        },
      ],
    });
    api.checkUpdate.mockResolvedValue({
      agent_id: 'codex',
      current_version: '@openai/codex 0.168.0',
      available_version: '0.169.0',
      update_available: false,
      runtime_current: '@openai/codex 0.168.0',
      runtime_available: '0.169.0',
      acp_current: null,
      acp_available: null,
      snapshot_id: null,
      fetched_at: null,
      fresh: true,
    });

    render(<AgentSettings />);
    await userEvent.click(
      await screen.findByRole('button', {
        name: '展开 运行入口 的检查详情',
      })
    );
    await waitFor(() =>
      expect(screen.getByTitle('@openai/codex 0.168.0')).toBeInTheDocument()
    );
    await waitFor(() => expect(screen.getAllByText('可更新')).toHaveLength(1));
  });

  it('checks for native runtime updates as part of Check Now in preflight', async () => {
    const user = userEvent.setup();
    api.preflight.mockResolvedValue({
      agent_id: 'codex',
      checked_at: '2026-09-09T00:00:00Z',
      items: [
        {
          id: 'native_runtime',
          label: '原生引擎运行时',
          status: 'pass',
          detail: '',
          version: '@openai/codex 0.168.0',
          path: '/usr/local/bin/codex',
          source: null,
          repairable: false,
          update_available: false,
          available_version: null,
          update_group: null,
        },
      ],
    });
    api.checkUpdate.mockResolvedValue({
      agent_id: 'codex',
      current_version: '@openai/codex 0.168.0',
      available_version: '0.169.0',
      update_available: true,
      runtime_current: '@openai/codex 0.168.0',
      runtime_available: '0.169.0',
      acp_current: null,
      acp_available: null,
      snapshot_id: null,
      fetched_at: null,
      fresh: true,
    });
    const success = vi.spyOn(toast, 'success');
    render(<AgentSettings />);
    await waitFor(() => expect(screen.getAllByText('可更新')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: '立即检查' }));
    await waitFor(() => expect(success).toHaveBeenCalledWith('预检查完成'));
    expect(api.checkUpdate).toHaveBeenCalledWith('codex', { force: true });
  });

  it('updates native runtime preflight items and toasts when an update finishes', async () => {
    api.preflight.mockResolvedValue({
      agent_id: 'codex',
      checked_at: '2026-08-21T00:00:00Z',
      items: [
        {
          id: 'native_runtime',
          label: '原生引擎运行时',
          status: 'pass',
          detail: '',
          version: '0.168.0',
          path: '/usr/local/bin/codex',
          source: null,
          repairable: true,
          update_available: true,
          available_version: '0.169.0',
          update_group: 'native-runtime',
        },
      ],
    });
    const success = vi.spyOn(toast, 'success');
    render(<AgentSettings />);
    await screen.findByRole('button', { name: 'Codex' });
    await waitFor(() =>
      expect(listeners.has('agent-management-event')).toBe(true)
    );
    await userEvent.click(
      await screen.findByRole('button', {
        name: '展开 运行入口 的检查详情',
      })
    );
    expect(await screen.findByTitle('0.168.0')).toBeInTheDocument();
    api.preflight.mockClear();
    api.bar.mockResolvedValue([
      {
        agent_id: 'codex',
        display_name: 'Codex',
        description: 'OpenAI Codex (official native app-server engine)',
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
        runtime_version: '0.169.0',
        acp_version: '0.169.0',
        active_operation: null,
        rollback_available: true,
        settings_features: ['authentication_mode'],
      },
    ]);

    await act(async () => {
      listeners.get('agent-management-event')?.({
        sequence: 1,
        agent_id: 'codex',
        operation_id: 'update-1',
        kind: 'update',
        status: 'running',
        progress_percent: 20,
        message: '正在安装 Agent 运行时',
      });
    });
    await act(async () => {
      listeners.get('agent-management-event')?.({
        sequence: 2,
        agent_id: 'codex',
        operation_id: 'update-1',
        kind: 'update',
        status: 'succeeded',
        progress_percent: 100,
        message: '安装与验证完成',
      });
    });

    await waitFor(() =>
      expect(success).toHaveBeenCalledWith('已完成运行时更新')
    );
    expect(api.preflight).toHaveBeenCalledWith('codex');
    await waitFor(() =>
      expect(screen.getByTitle('0.169.0')).toBeInTheDocument()
    );
    expect(screen.queryByTitle('0.168.0')).not.toBeInTheDocument();
    expect(screen.queryByText('可更新')).not.toBeInTheDocument();
  });

  it('reuses cached update status immediately without waiting for preflight and shows progress immediately on click', async () => {
    const user = userEvent.setup();
    recordAgentAcpUpdateCheck({
      agent_id: 'codex',
      current_version: '1.0.0',
      available_version: '1.1.0',
      runtime_current: '1.0.0',
      runtime_available: '1.1.0',
      acp_current: undefined,
      acp_available: undefined,
      update_available: true,
      snapshot_id: 'snap-1',
      fetched_at: '2026-11-05T00:00:00Z',
      fresh: true,
      compatibility_warning: undefined,
    });
    api.preflight.mockImplementation(() => new Promise(() => {}));
    api.checkUpdate.mockImplementation(() => new Promise(() => {}));
    let resolveUpdate: ((value: unknown) => void) | null = null;
    api.applyUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        })
    );

    render(<AgentSettings />);

    const updateButton = await screen.findByRole('button', { name: '可更新' });
    expect(updateButton).toBeVisible();

    await user.click(updateButton);

    expect(screen.getByText('基础环境检查')).toHaveAttribute(
      'data-state',
      'current'
    );
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('log', { name: '安装日志' })).toHaveTextContent(
      '$ dimo agent update codex'
    );

    await act(async () => {
      resolveUpdate?.({
        operation_id: 'op-update-1',
        agent_id: 'codex',
        kind: 'update',
        status: 'queued',
      });
    });
  });
});
