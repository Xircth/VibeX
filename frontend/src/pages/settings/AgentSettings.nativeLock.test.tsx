import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from '@/components/ui/toast';
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

describe('AgentSettings native engine lock gating', () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
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

  it.each([
    {
      agent_id: 'claude_code' as const,
      display_name: 'Claude Code',
      version: '2.1.325 (Claude Code)',
      path: 'C:/Users/example/.local/bin/claude.exe',
    },
    {
      agent_id: 'codex' as const,
      display_name: 'Codex',
      version: 'codex-cli 0.169.0',
      path: 'C:/Users/example/bin/codex.exe',
    },
  ])(
    'does not lock enabled $agent_id settings when verified native runtime evidence exists',
    async ({ agent_id, display_name, version, path }) => {
      api.bar.mockResolvedValue([
        {
          agent_id,
          display_name,
          description: `${display_name} native engine`,
          icon_light: null,
          icon_dark: null,
          icon_svg: null,
          source: 'built_in_profile',
          built_in: true,
          retired: false,
          enabled: true,
          position: 0,
          lifecycle: 'uninstalled',
          authentication: 'api_key',
          runtime_version: null,
          acp_version: null,
          local_runtime: { path, version },
          active_operation: null,
          rollback_available: false,
          settings_features: [
            'authentication_mode',
            'reusable_model_providers',
          ],
        },
      ]);
      api.preflight.mockResolvedValue({
        agent_id,
        checked_at: '2026-11-15T00:00:00Z',
        items: [
          {
            id: 'acp',
            label: '运行入口',
            status: 'pass',
            detail: '',
            version,
            path,
            source: null,
            repairable: true,
            update_available: false,
            available_version: null,
            update_group: null,
          },
        ],
      });
      api.readConfig.mockResolvedValue({
        agent_id,
        available: true,
        settings_features: ['authentication_mode', 'reusable_model_providers'],
        path: null,
        paths: [],
        fields: [],
        files: [],
        applies_to_next_session: true,
      });
      api.authMode.mockResolvedValue({
        agent_id,
        mode: 'model_provider',
        modes: ['official_subscription', 'official_api', 'model_provider'],
        options: [],
        credential_env: null,
        credential_present: true,
      });

      const warn = vi.spyOn(toast, 'warning');
      const user = userEvent.setup();
      render(<AgentSettings />);

      expect(
        await screen.findByRole('button', { name: display_name })
      ).toBeVisible();
      await waitFor(() =>
        expect(screen.getByRole('region', { name: '鉴权管理' })).toBeVisible()
      );
      expect(document.querySelector('.agent-settings-locked')).toBeNull();
      expect(
        screen.queryByRole('button', { name: '安装运行时' })
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole('region', { name: '鉴权管理' }));
      expect(warn).not.toHaveBeenCalledWith('请先安装Agent');
      warn.mockRestore();
    }
  );

  it.each([
    {
      agent_id: 'claude_code' as const,
      display_name: 'Claude Code',
      enabled: true,
    },
    {
      agent_id: 'codex' as const,
      display_name: 'Codex',
      enabled: true,
    },
    {
      agent_id: 'claude_code' as const,
      display_name: 'Claude Code',
      enabled: false,
      local_runtime: {
        path: 'C:/Users/example/.local/bin/claude.exe',
        version: '2.1.325 (Claude Code)',
      },
    },
    {
      agent_id: 'codex' as const,
      display_name: 'Codex',
      enabled: false,
      local_runtime: {
        path: 'C:/Users/example/bin/codex.exe',
        version: 'codex-cli 0.169.0',
      },
    },
  ])(
    'locks $agent_id settings when genuinely uninstalled or disabled (enabled=$enabled)',
    async ({ agent_id, display_name, enabled, local_runtime }) => {
      api.bar.mockResolvedValue([
        {
          agent_id,
          display_name,
          description: `${display_name} native engine`,
          icon_light: null,
          icon_dark: null,
          icon_svg: null,
          source: 'built_in_profile',
          built_in: true,
          retired: false,
          enabled,
          position: 0,
          lifecycle: 'uninstalled',
          authentication: 'not_logged_in',
          runtime_version: null,
          acp_version: null,
          local_runtime: local_runtime ?? null,
          active_operation: null,
          rollback_available: false,
          settings_features: [
            'authentication_mode',
            'reusable_model_providers',
          ],
        },
      ]);
      api.preflight.mockResolvedValue({
        agent_id,
        checked_at: '2026-11-15T00:00:00Z',
        items: [
          {
            id: 'acp',
            label: '运行入口',
            status: 'fail',
            detail: '未发现官方 CLI 运行时',
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
      api.readConfig.mockResolvedValue({
        agent_id,
        available: true,
        settings_features: ['authentication_mode', 'reusable_model_providers'],
        path: null,
        paths: [],
        fields: [],
        files: [],
        applies_to_next_session: true,
      });

      const warn = vi.spyOn(toast, 'warning');
      const user = userEvent.setup();
      render(<AgentSettings />);

      expect(
        await screen.findByRole('button', { name: display_name })
      ).toBeVisible();
      expect(screen.getByRole('region', { name: '鉴权管理' })).toBeVisible();
      await waitFor(() =>
        expect(document.querySelector('.agent-settings-locked')).not.toBeNull()
      );
      if (enabled) {
        expect(
          screen.getByRole('button', { name: '安装运行时' })
        ).toBeVisible();
      }

      await user.click(screen.getByRole('region', { name: '鉴权管理' }));
      expect(warn).toHaveBeenCalledWith('请先安装Agent');
      warn.mockRestore();
    }
  );
});
