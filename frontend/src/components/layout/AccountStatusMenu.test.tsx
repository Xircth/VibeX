import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { resetAccountOverviewCache } from '@/features/model-router/useVibeXAccount';
import { configApi, webServiceApi } from '@/lib/api';

import { AccountStatusMenu } from './AccountStatusMenu';

vi.mock('@/lib/api/settingsWindow', () => ({
  openSettingsSurface: vi.fn(
    (navigate: (path: string) => void, path?: string) =>
      navigate(path ?? '/settings')
  ),
}));

function LocationEcho() {
  const location = useLocation();
  return (
    <div data-testid="account-route-echo">
      {location.pathname}
      {location.search}
    </div>
  );
}

function stubConfig(): Config {
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

describe('AccountStatusMenu', () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  const trackSpy = <T extends { mockRestore: () => void }>(spy: T): T => {
    spies.push(spy);
    return spy;
  };

  beforeEach(() => {
    window.localStorage.clear();
    resetAccountOverviewCache();
    resetAccountHostConfigsForTests();
    trackSpy(
      vi.spyOn(configApi, 'getConfig').mockResolvedValue({
        config: stubConfig(),
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
    trackSpy(vi.spyOn(agentManagementApi, 'bar').mockResolvedValue([]));
    trackSpy(
      vi.spyOn(webServiceApi, 'getStatus').mockResolvedValue({
        running: false,
        port: 17891,
        address: null,
        token_configured: false,
        started_at: null,
        message: null,
        host_id: 'local-host-1',
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

  afterEach(() => {
    while (spies.length > 0) {
      spies.pop()?.mockRestore();
    }
    vi.clearAllMocks();
  });

  it('shows the signed-out menu and navigates to /settings/account when clicking sign in', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<AccountStatusMenu />} />
          <Route path="/settings/account" element={<div>Account Page</div>} />
        </Routes>
      </MemoryRouter>
    );

    const trigger = screen.getByTestId('account-status-menu-trigger');
    await user.click(trigger);

    expect(
      screen.getByTestId('account-status-menu-content')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('account-status-menu-item-agents')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('account-status-menu-item-models')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('account-status-menu-item-plugins')
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('account-status-menu-item-subscription')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('account-status-menu-item-usage')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('account-status-menu-item-sign-out')
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId('account-status-menu-profile'));
    expect(await screen.findByText('Account Page')).toBeInTheDocument();
  });

  it('shows user avatar initial, omits quick Host import entry, and handles sign-out when signed in', async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_STORAGE_KEY, 'vbx_tok_test');
    window.localStorage.setItem(
      ACCOUNT_HOST_CONFIGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        accounts: {
          xielinge: {
            hosts: {
              'host:remote-devbox': {
                schemaVersion: 1,
                accountKey: 'xielinge',
                hostId: 'host:remote-devbox',
                hostName: 'Remote Devbox',
                kind: 'ssh',
                osType: 'Linux',
                osArch: 'x86_64',
                updatedAt: '2026-11-11T05:00:00.000Z',
                fingerprint: 'v1_remote',
                vibeXSettings: {
                  userConfig: {},
                  frontendPreferences: {},
                },
                agents: [],
              },
            },
            deleted: {},
          },
        },
      })
    );

    trackSpy(
      vi.spyOn(accountApi, 'overview').mockResolvedValue({
        user: {
          displayName: '谢麟阁',
          username: 'xielinge',
          email: '18190151110@163.com',
        },
        balanceMicro: 2_500_000,
        agents: [],
        tasks: [],
        models: [],
      })
    );
    const signOutSpy = trackSpy(
      vi.spyOn(accountApi, 'signOut').mockImplementation(async () => {
        window.localStorage.removeItem(ACCOUNT_TOKEN_STORAGE_KEY);
      })
    );

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<AccountStatusMenu />} />
          <Route path="/settings/account" element={<LocationEcho />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(
        screen.getByTestId('account-status-menu-trigger')
      ).toHaveTextContent('谢')
    );

    await user.click(screen.getByTestId('account-status-menu-trigger'));
    expect(screen.getByText('谢麟阁')).toBeInTheDocument();
    expect(screen.getByText('18190151110@163.com')).toBeInTheDocument();

    expect(
      screen.queryByTestId('account-status-menu-item-import-host-config')
    ).not.toBeInTheDocument();

    const signOutBtn = screen.getByTestId('account-status-menu-item-sign-out');
    await user.click(signOutBtn);
    expect(signOutSpy).toHaveBeenCalledTimes(1);
  });
});
