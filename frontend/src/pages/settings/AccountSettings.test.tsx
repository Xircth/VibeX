import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorType, SoundFile, ThemeMode, type Config } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';
import {
  ACCOUNT_TOKEN_STORAGE_KEY,
  AccountError,
  accountApi,
} from '@/features/model-router/account';
import {
  ACCOUNT_HOST_CONFIGS_STORAGE_KEY,
  resetAccountHostConfigsForTests,
} from '@/features/model-router/accountHostConfigs';
import * as openExternalModule from '@/features/model-router/openExternal';
import { resetAccountOverviewCache } from '@/features/model-router/useVibeXAccount';
import { configApi, webServiceApi } from '@/lib/api';

import { AccountSettings } from './AccountSettings';

function buildStubConfig(): Config {
  return {
    config_version: 'v8',
    theme: ThemeMode.DARK,
    executor_profile: {
      executor: 'CLAUDE_CODE',
      variant: null,
      model: null,
      fast_mode: null,
    },
    disclaimer_acknowledged: true,
    onboarding_acknowledged: true,
    notifications: {
      sound_enabled: true,
      push_enabled: true,
      sound_file: SoundFile.ABSTRACT_SOUND1,
      notify_when: 'unfocused',
    },
    editor: {
      editor_type: EditorType.VS_CODE,
      custom_command: null,
      remote_ssh_host: null,
      remote_ssh_user: null,
    },
    github: {
      pat: null,
      oauth_token: null,
      username: null,
      primary_email: null,
      default_pr_base: null,
    },
    workspace_dir: null,
    last_app_version: null,
    show_release_notes: true,
    language: 'ZH_HANS',
    git_branch_prefix: 'feat/',
    pr_auto_description_enabled: false,
    pr_auto_description_prompt: null,
    pr_auto_description_agent_id: '',
    pr_auto_description_mode: null,
    pr_auto_description_session_config: {},
    commit_reminder_enabled: false,
    commit_reminder_mode: 'smart',
    commit_reminder_line_threshold: 200,
    send_message_shortcut: 'Enter',
    prompt_enhancement_enabled: false,
    prompt_enhancement_model: '',
    prompt_enhancement_agent_id: '',
    prompt_enhancement_mode: null,
    prompt_enhancement_session_config: {},
    prompt_enhancement_prompt: null,
    compact_context_enabled: false,
    default_terminal_shell: null,
    files_changed_default_collapsed: false,
    ai_message_default_collapsed: false,
    hide_model_thinking: false,
    previous_session_continuation_enabled: false,
    auto_update_enabled: true,
    crash_reports_enabled: false,
    link_open_behavior: 'ExternalBrowser',
    multi_agent_enabled: true,
    multi_agent_depth_limit: 3,
    multi_agent_completed_cache_max_mb: 128,
    multi_agent_conversation_list_default_days: 7,
    multi_agent_delay_max_hours: 24,
    multi_agent_agent_defaults: {},
  };
}

describe('AccountSettings', () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  const trackSpy = <T extends { mockRestore: () => void }>(spy: T): T => {
    spies.push(spy);
    return spy;
  };

  beforeEach(() => {
    while (spies.length > 0) {
      spies.pop()?.mockRestore();
    }
    window.localStorage.clear();
    resetAccountOverviewCache();
    resetAccountHostConfigsForTests();

    trackSpy(
      vi.spyOn(configApi, 'getConfig').mockResolvedValue({
        config: buildStubConfig(),
        environment: {
          os_type: 'Windows',
          os_version: '11',
          os_architecture: 'x86_64',
          bitness: '64-bit',
        },
        capabilities: {},
        executors: {},
      })
    );
    trackSpy(
      vi.spyOn(configApi, 'saveConfig').mockImplementation(async (next) => next)
    );
    trackSpy(
      vi.spyOn(agentManagementApi, 'bar').mockResolvedValue([
        {
          agent_id: 'CLAUDE_CODE',
          display_name: 'Claude Code',
          description: 'Claude Code',
          icon_light: null,
          icon_dark: null,
          icon_svg: null,
          source: 'built_in_profile',
          built_in: true,
          retired: false,
          enabled: true,
          position: 0,
          lifecycle: 'ready',
          authentication: 'not_required',
          runtime_version: '1.0.0',
          acp_version: '1.0.0',
          active_operation: null,
          rollback_available: false,
        },
        {
          agent_id: 'CODEX',
          display_name: 'Codex',
          description: 'Codex',
          icon_light: null,
          icon_dark: null,
          icon_svg: null,
          source: 'built_in_profile',
          built_in: true,
          retired: false,
          enabled: false,
          position: 1,
          lifecycle: 'ready',
          authentication: 'not_required',
          runtime_version: '1.0.0',
          acp_version: '1.0.0',
          active_operation: null,
          rollback_available: false,
        },
      ])
    );
    trackSpy(
      vi.spyOn(webServiceApi, 'getStatus').mockResolvedValue({
        running: false,
        port: 17891,
        address: null,
        token_configured: false,
        started_at: null,
        message: null,
        host_id: 'current-win-host',
      })
    );
    trackSpy(
      vi
        .spyOn(accountApi, 'listHostConfigs')
        .mockRejectedValue(new AccountError('unsupported'))
    );
    trackSpy(
      vi
        .spyOn(accountApi, 'saveHostConfig')
        .mockRejectedValue(new AccountError('unsupported'))
    );
  });

  it('hides Subscription & Usage and Host list when signed out of VibeX', () => {
    render(
      <MemoryRouter>
        <AccountSettings />
      </MemoryRouter>
    );

    expect(screen.getByTestId('account-settings-page')).toBeInTheDocument();
    expect(
      screen.queryByTestId('account-subscription-section')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('account-host-list-section')
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText(/登录 VibeX 账号|Sign in to VibeX/i).length
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText(/安全密钥 \(Passkey\)|Security Key \(Passkey\)/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/历史账单记录|Billing History/i)
    ).toBeInTheDocument();
  });

  it('renders Subscription & Usage and Host list inside Account when signed in, and opens official Plan & Credits or imports Host config', async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_STORAGE_KEY, 'vbx_tok_test');
    window.localStorage.setItem(
      ACCOUNT_HOST_CONFIGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        accounts: {
          '6371264023892238337': {
            hosts: {
              'host:macbook-studio': {
                schemaVersion: 1,
                accountKey: '6371264023892238337',
                hostId: 'host:macbook-studio',
                hostName: 'MacBook Studio',
                kind: 'ssh',
                osType: 'macOS',
                osArch: 'aarch64',
                updatedAt: '2026-11-11T06:30:00.000Z',
                fingerprint: 'v1_macbook_studio',
                vibeXSettings: {
                  userConfig: { send_message_shortcut: 'ModifierEnter' },
                  frontendPreferences: { ui_zoom: 1.15 },
                },
                agents: [
                  {
                    agentId: 'CLAUDE_CODE',
                    displayName: 'Claude Code',
                    enabled: true,
                    position: 0,
                    builtIn: true,
                  },
                  {
                    agentId: 'CODEX',
                    displayName: 'Codex',
                    enabled: true,
                    position: 1,
                    builtIn: true,
                  },
                ],
              },
            },
            deleted: {},
          },
        },
      })
    );

    const openExternalSpy = trackSpy(
      vi.spyOn(openExternalModule, 'openExternal').mockResolvedValue(undefined)
    );

    trackSpy(
      vi.spyOn(accountApi, 'overview').mockResolvedValue({
        user: {
          displayName: '谢麟阁',
          username: '6371264023892238337',
          email: '18190151110@163.com',
          tier: 'subscriber',
        },
        balanceMicro: 38_500_000,
        serverNow: '2026-11-11T10:00:00.000Z',
        grants: [
          {
            id: 'grant-1',
            source: 'order',
            orderNo: 'ORD-20261111',
            note: '50 额度包',
            amountMicro: 50_000_000,
            remainingMicro: 38_500_000,
            createdAt: '2026-11-01T00:00:00.000Z',
            expiresAt: '2027-05-01T00:00:00.000Z',
            voided: false,
          },
        ],
        usage30d: {
          totalRecords: 42,
          modelNames: {
            'claude-opus-5-5': 'Claude Opus 5.5',
            'gpt-5-4': 'GPT-5.4',
          },
          byModel: [
            {
              modelId: 'claude-opus-5-5',
              costMicro: 8_500_000,
              requests: 28,
              tokens: 1_240_000,
            },
            {
              modelId: 'gpt-5-4',
              costMicro: 3_000_000,
              requests: 14,
              tokens: 610_000,
            },
          ],
          daily: [],
        },
        agents: [],
        tasks: [],
        models: [],
      })
    );

    const setEnabledSpy = trackSpy(
      vi.spyOn(agentManagementApi, 'setEnabled').mockResolvedValue({
        agent_id: 'CODEX',
        display_name: 'Codex',
        description: 'Codex',
        icon_light: null,
        icon_dark: null,
        icon_svg: null,
        source: 'built_in_profile',
        built_in: true,
        retired: false,
        enabled: true,
        position: 1,
        lifecycle: 'ready',
        authentication: 'not_required',
        runtime_version: '1.0.0',
        acp_version: '1.0.0',
        active_operation: null,
        rollback_available: false,
      })
    );

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AccountSettings />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('谢麟阁')).toBeInTheDocument());
    expect(screen.getByText('18190151110@163.com')).toBeInTheDocument();
    expect(screen.getByText(/6371264023892238337/)).toBeInTheDocument();

    // Subscription & Usage section is embedded inside AccountSettings
    expect(
      screen.getByTestId('account-subscription-section')
    ).toBeInTheDocument();
    expect(screen.getByTestId('subscription-plan-name')).toHaveTextContent(
      /VibeX 订阅套餐|VibeX Subscriber Plan/i
    );
    expect(screen.getByTestId('subscription-balance-value')).toHaveTextContent(
      '38.50'
    );
    expect(screen.getByTestId('subscription-spent30d-value')).toHaveTextContent(
      '11.50'
    );
    expect(screen.getByTestId('credit-grant-row-grant-1')).toHaveTextContent(
      '50 额度包'
    );
    expect(
      screen.getByTestId('model-usage-row-claude-opus-5-5')
    ).toHaveTextContent('Claude Opus 5.5');
    expect(screen.getByTestId('model-usage-row-gpt-5-4')).toHaveTextContent(
      'GPT-5.4'
    );

    await user.click(screen.getByTestId('open-site-plan-details'));
    expect(openExternalSpy).toHaveBeenCalledWith(
      expect.stringContaining('/account/plan')
    );

    // Host list section with current Host row + MacBook Studio row appears
    await waitFor(() =>
      expect(
        screen.getByTestId('account-saved-host-row-host:macbook-studio')
      ).toBeInTheDocument()
    );
    expect(screen.getByTestId('account-host-list-section')).toBeInTheDocument();
    expect(screen.getByTestId('account-current-host-row')).toBeInTheDocument();

    const importBtn = screen.getByTestId(
      'account-import-host-host:macbook-studio'
    );
    expect(importBtn).toHaveTextContent(/导入该 Host 配置|Import Host Config/i);

    await user.click(importBtn);

    const dialog = await screen.findByTestId('account-host-import-dialog');
    expect(within(dialog).getByText('MacBook Studio')).toBeInTheDocument();

    await user.click(within(dialog).getByTestId('confirm-host-config-import'));

    await waitFor(() => {
      expect(configApi.saveConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          send_message_shortcut: 'ModifierEnter',
        })
      );
      expect(setEnabledSpy).toHaveBeenCalledWith('CODEX', true);
    });
    expect(window.localStorage.getItem('vibex:ui-zoom')).toBe('1.15');
  });
});
