import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentAuthModeKind } from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { agentManagementApi } from '@/features/agent-management';

import { clearAllAgentAuthKindTabs } from './agentAuthKindTab';
import { clearAllAgentSettingsDrafts } from './agentSettingsDraftRetention';
import { pickAuthModeTab } from './agentSettingsTestUtils';
import { AgentAuthModeControl } from './AgentAuthModeControl';

vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: { show: vi.fn() },
}));

const claudeActions = {
  agent_id: 'claude_code' as const,
  actions: [
    {
      id: 'login',
      label: '登录 Claude Code',
      description: '运行 Claude Code 官方账号登录流程。',
      label_key: 'agents.managementAction.claude_code.login.label',
      description_key: 'agents.managementAction.claude_code.login.description',
      kind: 'login' as const,
      available: true,
      unavailable_reason: null,
      url: null,
    },
    {
      id: 'logout',
      label: '退出 Claude Code',
      description: '移除 Claude Code 本地账号会话。',
      label_key: 'agents.managementAction.claude_code.logout.label',
      description_key: 'agents.managementAction.claude_code.logout.description',
      kind: 'logout' as const,
      available: false,
      unavailable_reason: '当前没有可退出的账号会话。',
      url: null,
    },
  ],
};

const grokOptions = [
  authOption(
    'subscription',
    'subscription',
    'authModeSubscription',
    'authDescGrokSubscription'
  ),
  authOption(
    'api_key',
    'official_api',
    'authModeXaiKey',
    'authDescGrokKey',
    'XAI_API_KEY',
    'grok_api_key',
    'https://api.x.ai/v1'
  ),
  authOption(
    'custom',
    'provider',
    'authModeCustomEndpoint',
    'authDescGrokCustom'
  ),
];

const claudeOptions = [
  authOption(
    'official_subscription',
    'subscription',
    'authModeOfficialSubscription',
    'authDescClaudeSubscription'
  ),
  authOption(
    'official_api',
    'official_api',
    'authModeOfficialApi',
    'authDescClaudeOfficialApi',
    'ANTHROPIC_API_KEY',
    'anthropic_api_key',
    'https://api.anthropic.com'
  ),
  authOption(
    'model_provider',
    'provider',
    'authModeProvider',
    'authDescClaudeProvider'
  ),
];

const antigravityOptions = [
  authOption(
    'oauth-personal',
    'subscription',
    'authModeGoogleLogin',
    'authDescAntigravityOauthPersonal'
  ),
  authOption(
    'oauth-business',
    'subscription',
    'authModeAntigravityEnterprise',
    'authDescAntigravityOauthBusiness'
  ),
  authOption(
    'gemini-api-key',
    'official_api',
    'authModeGeminiKey',
    'authDescAntigravityApiKey',
    'GEMINI_API_KEY',
    'antigravity_api_key'
  ),
  authOption(
    'agent-platform',
    'official_api',
    'authModeAntigravityPlatform',
    'authDescAntigravityPlatform',
    'GOOGLE_API_KEY',
    'antigravity_google_api_key'
  ),
];

describe('AgentAuthModeControl (signed-in states & provider-specific flows)', () => {
  afterEach(() => {
    clearAllAgentSettingsDrafts();
    clearAllAgentAuthKindTabs();
    vi.mocked(ConfirmDialog.show).mockReset();
    vi.restoreAllMocks();
  });

  it('hides login and shows logout when the official account is signed in', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'official_subscription',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      account_label: 'linus@example.com',
      modes: ['official_subscription', 'official_api', 'model_provider'],
      options: claudeOptions,
    });

    render(
      <AgentAuthModeControl
        actions={{
          ...claudeActions,
          actions: claudeActions.actions.map((action) =>
            action.kind === 'logout'
              ? { ...action, available: true, unavailable_reason: null }
              : action
          ),
        }}
        agentId="claude_code"
        authentication="account"
        onRunAction={vi.fn()}
      />
    );

    expect(await screen.findByTestId('agent-account-identity')).toHaveAttribute(
      'data-state',
      'identified'
    );
    expect(screen.getByText('linus@example.com')).toBeVisible();
    expect(
      screen.getByRole('status', {
        name: '当前登录账户：linus@example.com',
      })
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: '登录 Claude Code' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '退出 Claude Code' })
    ).toBeVisible();
  });

  it('keeps the account signed in when user information is missing', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'official_subscription',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      modes: ['official_subscription', 'official_api', 'model_provider'],
      options: claudeOptions,
    });

    render(
      <AgentAuthModeControl agentId="claude_code" authentication="account" />
    );

    expect(await screen.findByTestId('agent-account-identity')).toHaveAttribute(
      'data-state',
      'unknown'
    );
    expect(screen.getByText('未获得有效用户信息')).toBeVisible();
  });

  it('shows login after logout even when the logout command is still available', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'official_subscription',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      modes: ['official_subscription', 'official_api', 'model_provider'],
      options: claudeOptions,
    });

    render(
      <AgentAuthModeControl
        actions={{
          agent_id: 'claude_code',
          actions: [
            { ...claudeActions.actions[0], available: true },
            {
              ...claudeActions.actions[1],
              available: true,
              unavailable_reason: null,
            },
            {
              id: 'subscription',
              label: '管理 Claude 订阅',
              description: '打开 Claude 订阅管理。',
              label_key:
                'agents.managementAction.claude_code.subscription.label',
              description_key:
                'agents.managementAction.claude_code.subscription.description',
              kind: 'subscription',
              available: true,
              unavailable_reason: null,
              url: 'https://claude.ai',
            },
          ],
        }}
        agentId="claude_code"
        authentication="not_logged_in"
        onRunAction={vi.fn()}
      />
    );

    expect(await screen.findByText('未登录官方账号')).toBeVisible();
    expect(
      screen.getByRole('button', { name: '登录 Claude Code' })
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: '退出 Claude Code' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '管理 Claude 订阅' })
    ).not.toBeInTheDocument();
  });

  it('puts Antigravity subscription logins on the account status row', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'antigravity',
      mode: 'oauth-personal',
      credential_env: 'GEMINI_API_KEY',
      credential_present: false,
      modes: [
        'oauth-personal',
        'oauth-business',
        'gemini-api-key',
        'agent-platform',
      ],
      options: antigravityOptions,
    });

    render(
      <AgentAuthModeControl
        agentId="antigravity"
        authentication="not_logged_in"
      />
    );

    const status = await screen.findByTestId('agent-account-identity');
    const row = status.closest('.agent-account-session');
    expect(row).not.toBeNull();
    expect(status).toHaveTextContent('未登录官方账号');
    expect(
      within(row as HTMLElement).getByRole('button', {
        name: 'Google 登录（OAuth）',
      })
    ).toBeVisible();
    expect(
      within(row as HTMLElement).getByRole('button', {
        name: 'Gemini Enterprise',
      })
    ).toBeVisible();
  });

  describe('Antigravity sign-in', () => {
    const antigravityLogin = {
      agent_id: 'antigravity' as const,
      actions: [
        {
          id: 'login',
          label: '登录',
          description: '在浏览器中完成 Antigravity 账号登录',
          label_key: 'agents.managementAction.antigravity.login.label',
          description_key:
            'agents.managementAction.antigravity.login.description',
          kind: 'login' as const,
          available: true,
          unavailable_reason: null,
          url: null,
        },
      ],
    };
    const antigravityView = (mode: string) => ({
      agent_id: 'antigravity' as const,
      mode,
      credential_env: 'GEMINI_API_KEY',
      credential_present: false,
      modes: [
        'oauth-personal',
        'oauth-business',
        'gemini-api-key',
        'agent-platform',
      ],
      options: antigravityOptions,
    });

    it('saves the chosen account type before starting the browser sign-in', async () => {
      vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue(
        antigravityView('oauth-personal')
      );
      const save = vi
        .spyOn(agentManagementApi, 'setAuthMode')
        .mockResolvedValue(antigravityView('oauth-business'));
      const onRunAction = vi.fn();
      const user = userEvent.setup();

      render(
        <AgentAuthModeControl
          agentId="antigravity"
          authentication="not_logged_in"
          actions={antigravityLogin}
          onRunAction={onRunAction}
        />
      );

      await user.click(
        await screen.findByRole('button', { name: 'Gemini Enterprise' })
      );
      expect(save).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: '登录' }));

      await waitFor(() => expect(onRunAction).toHaveBeenCalledWith('login'));
      expect(save).toHaveBeenCalledWith('antigravity', 'oauth-business', null);
      expect(save.mock.invocationCallOrder[0]).toBeLessThan(
        onRunAction.mock.invocationCallOrder[0]
      );
    });

    it('signs in with the saved account type without saving it again', async () => {
      vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue(
        antigravityView('oauth-personal')
      );
      const save = vi.spyOn(agentManagementApi, 'setAuthMode');
      const onRunAction = vi.fn();
      const user = userEvent.setup();

      render(
        <AgentAuthModeControl
          agentId="antigravity"
          authentication="not_logged_in"
          actions={antigravityLogin}
          onRunAction={onRunAction}
        />
      );

      await user.click(await screen.findByRole('button', { name: '登录' }));

      expect(onRunAction).toHaveBeenCalledWith('login');
      expect(save).not.toHaveBeenCalled();
    });

    it('shows the project settings only for the Gemini Enterprise account type', async () => {
      vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue(
        antigravityView('oauth-personal')
      );
      const user = userEvent.setup();

      render(
        <AgentAuthModeControl
          agentId="antigravity"
          authentication="not_logged_in"
          actions={antigravityLogin}
          configuration={<input aria-label="Google Cloud Project" />}
          configurationOnAccount={(mode) => mode === 'oauth-business'}
        />
      );

      await screen.findByRole('button', { name: 'Gemini Enterprise' });
      expect(screen.getByLabelText('Google Cloud Project')).not.toBeVisible();
      await user.click(
        screen.getByRole('button', { name: 'Gemini Enterprise' })
      );
      expect(screen.getByLabelText('Google Cloud Project')).toBeVisible();
    });
  });

  it('maps Antigravity credentials to the native configuration form', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'antigravity',
      mode: 'oauth-personal',
      credential_env: 'GEMINI_API_KEY',
      credential_present: false,
      modes: [
        'oauth-personal',
        'oauth-business',
        'gemini-api-key',
        'agent-platform',
      ],
      options: antigravityOptions,
    });
    const save = vi.spyOn(agentManagementApi, 'setAuthMode').mockResolvedValue({
      agent_id: 'antigravity',
      mode: 'gemini-api-key',
      credential_env: 'GEMINI_API_KEY',
      credential_present: true,
      modes: [
        'oauth-personal',
        'oauth-business',
        'gemini-api-key',
        'agent-platform',
      ],
      options: antigravityOptions,
    });
    const user = userEvent.setup();

    render(
      <AgentAuthModeControl
        agentId="antigravity"
        configuration={<input aria-label="Native Gemini key" />}
        nativeCredentialPresent={(fieldId) => fieldId === 'antigravity_api_key'}
      />
    );

    expect(
      await screen.findByRole('tablist', {
        name: 'Google Antigravity 鉴权模式',
      })
    ).toBeVisible();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    await pickAuthModeTab(user, '官方 API');
    expect(screen.getByLabelText('Native Gemini key')).toBeVisible();

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('antigravity', 'gemini-api-key', null)
    );
  });

  it('does not render auth-kind tabs for Qoder subscription-only auth', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'qoder',
      mode: 'official_subscription',
      credential_env: 'QODER_PERSONAL_ACCESS_TOKEN',
      credential_present: false,
      modes: ['official_subscription'],
      options: [
        authOption(
          'official_subscription',
          'subscription',
          'authModeOfficialSubscription',
          'authDescQoderSubscription'
        ),
      ],
    });

    render(
      <AgentAuthModeControl
        agentId="qoder"
        authentication="not_logged_in"
        actions={{
          agent_id: 'qoder',
          actions: [
            {
              id: 'login',
              label: '登录 Qoder',
              description: '打开浏览器完成 Qoder 官方账号登录',
              label_key: 'agents.managementAction.qoder.login.label',
              description_key:
                'agents.managementAction.qoder.login.description',
              kind: 'login' as const,
              available: true,
              unavailable_reason: null,
              url: null,
            },
          ],
        }}
      />
    );

    expect(await screen.findByTestId('agent-account-identity')).toBeVisible();
    expect(screen.getByRole('button', { name: '登录 Qoder' })).toBeVisible();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
  });

  it('does not render auth-kind tabs when the Agent only has Provider mode', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'pi',
      mode: 'model_provider',
      credential_env: 'PI_API_KEY',
      credential_present: true,
      modes: ['model_provider'],
      options: [
        authOption(
          'model_provider',
          'provider',
          'authModeProvider',
          'authDescPiProvider'
        ),
      ],
    });

    render(
      <AgentAuthModeControl
        agentId="pi"
        modelProvider={<input aria-label="Pi Provider" />}
      />
    );

    expect(await screen.findByLabelText('Pi Provider')).toBeVisible();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
  });

  it('reopens on the Agent config mode even if a previous tab was remembered', async () => {
    const authView = {
      agent_id: 'claude_code' as const,
      mode: 'official_subscription',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      modes: ['official_subscription', 'official_api', 'model_provider'],
      options: claudeOptions,
    };
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue(authView);
    const user = userEvent.setup();

    const { unmount } = render(
      <AgentAuthModeControl
        agentId="claude_code"
        authentication="account"
        modelProvider={<div data-testid="model-provider">Provider fields</div>}
      />
    );

    expect(
      await screen.findByRole('tab', { name: '官方订阅' })
    ).toHaveAttribute('aria-selected', 'true');

    await pickAuthModeTab(user, '供应商');
    expect(screen.getByRole('tab', { name: '供应商' })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    await pickAuthModeTab(user, '官方订阅');
    expect(screen.getByRole('tab', { name: '官方订阅' })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    unmount();
    vi.mocked(agentManagementApi.authMode).mockResolvedValue({
      ...authView,
      mode: 'model_provider',
      credential_present: true,
    });
    const save = vi.spyOn(agentManagementApi, 'setAuthMode');

    render(
      <AgentAuthModeControl
        agentId="claude_code"
        authentication="account"
        modelProvider={<div data-testid="model-provider">Provider fields</div>}
      />
    );

    expect(await screen.findByRole('tab', { name: '供应商' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('tab', { name: '官方订阅' })).toHaveAttribute(
      'aria-selected',
      'false'
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('does not reuse one agent tab choice as another agent default', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockImplementation(
      async (agentId) =>
        agentId === 'grok'
          ? {
              agent_id: 'grok',
              mode: 'subscription',
              credential_env: 'XAI_API_KEY',
              credential_present: false,
              modes: ['subscription', 'api_key', 'custom'],
              options: grokOptions,
            }
          : {
              agent_id: 'claude_code',
              mode: 'official_subscription',
              credential_env: 'ANTHROPIC_API_KEY',
              credential_present: false,
              modes: [
                'official_subscription',
                'official_api',
                'model_provider',
              ],
              options: claudeOptions,
            }
    );
    const user = userEvent.setup();

    const { unmount } = render(
      <AgentAuthModeControl
        agentId="grok"
        authentication="account"
        modelProvider={<div data-testid="model-provider">Provider fields</div>}
      />
    );
    await pickAuthModeTab(user, '供应商');
    unmount();

    render(
      <AgentAuthModeControl
        agentId="claude_code"
        authentication="account"
        modelProvider={<div data-testid="model-provider">Provider fields</div>}
      />
    );

    expect(
      await screen.findByRole('tab', { name: '官方订阅' })
    ).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '供应商' })).toHaveAttribute(
      'aria-selected',
      'false'
    );
  });

  it('expands token and browser login options below the login button when headless_account_env is present', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'qoder',
      mode: 'official_subscription',
      credential_env: 'QODER_API_KEY',
      credential_present: false,
      headless_account_env: 'QODER_PERSONAL_ACCESS_TOKEN',
      modes: ['official_subscription', 'official_api', 'model_provider'],
      options: [
        authOption(
          'official_subscription',
          'subscription',
          'authModeOfficialSubscription',
          'authDescQoderSubscription'
        ),
        authOption(
          'official_api',
          'official_api',
          'authModeOfficialApi',
          'authDescQoderOfficialApi',
          'QODER_API_KEY',
          undefined,
          'https://openapi.qoder.com'
        ),
        authOption(
          'model_provider',
          'provider',
          'authModeProvider',
          'authDescQoderProvider'
        ),
      ],
    });
    vi.spyOn(agentManagementApi, 'environment').mockResolvedValue({
      agent_id: 'qoder',
      revision: 'rev-1',
      entries: [],
    });
    const onRunAction = vi.fn();
    const user = userEvent.setup();

    render(
      <AgentAuthModeControl
        agentId="qoder"
        authentication="not_logged_in"
        actions={{
          agent_id: 'qoder',
          actions: [
            {
              id: 'login',
              label: '登录 Qoder',
              description: '打开浏览器完成 Qoder 官方账号登录',
              label_key: 'agents.managementAction.qoder.login.label',
              description_key:
                'agents.managementAction.qoder.login.description',
              kind: 'login' as const,
              available: true,
              unavailable_reason: null,
              url: null,
            },
          ],
        }}
        onRunAction={onRunAction}
      />
    );

    const loginBtn = await screen.findByRole('button', { name: '登录 Qoder' });
    expect(loginBtn).toBeVisible();
    expect(
      screen.queryByRole('button', { name: '输入 Token' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('QODER_PERSONAL_ACCESS_TOKEN')
    ).not.toBeVisible();

    await user.click(loginBtn);
    expect(onRunAction).not.toHaveBeenCalled();

    const tokenChoiceBtn = screen.getByRole('button', { name: '输入 Token' });
    const browserChoiceBtn = screen.getByRole('button', { name: '浏览器登录' });
    expect(tokenChoiceBtn).toBeVisible();
    expect(browserChoiceBtn).toBeVisible();

    await user.click(tokenChoiceBtn);
    expect(
      await screen.findByLabelText('QODER_PERSONAL_ACCESS_TOKEN')
    ).toBeVisible();

    await user.click(browserChoiceBtn);
    expect(onRunAction).toHaveBeenCalledWith('login');
  });

  it('renders an icon inside every auth mode tab', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'official_subscription',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      modes: ['official_subscription', 'official_api', 'model_provider'],
      options: claudeOptions,
    });

    render(
      <AgentAuthModeControl
        agentId="claude_code"
        authentication="not_logged_in"
      />
    );

    const tablist = await screen.findByRole('tablist');
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      expect(tab.querySelector('svg.agent-auth-mode-tab-icon')).not.toBeNull();
    }
  });
});

function authOption(
  value: string,
  kind: AgentAuthModeKind,
  label: string,
  description: string,
  credentialEnv?: string,
  nativeConfigFieldId?: string,
  officialApiUrl?: string
) {
  return {
    value,
    kind,
    label_key: `agents.${label}`,
    description_key: `agents.${description}`,
    credential_env: credentialEnv ?? null,
    credential_required: credentialEnv !== undefined,
    native_config_field_id: nativeConfigFieldId ?? null,
    official_api_url: officialApiUrl,
  };
}
