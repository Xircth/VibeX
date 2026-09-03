import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentAuthModeKind } from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { agentManagementApi } from '@/features/agent-management';

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
const codexOptions = [
  authOption(
    'chatgpt_subscription',
    'subscription',
    'authModeChatGpt',
    'authDescCodexSubscription'
  ),
  authOption(
    'api_key',
    'official_api',
    'authModeOpenAiKey',
    'authDescCodexKey',
    'OPENAI_API_KEY',
    'openai_api_key',
    'https://api.openai.com/v1'
  ),
  authOption(
    'model_provider',
    'provider',
    'authModeProvider',
    'authDescCodexProvider'
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

describe('AgentAuthModeControl', () => {
  afterEach(() => {
    clearAllAgentSettingsDrafts();
    vi.restoreAllMocks();
  });

  it('switches Grok to subscription immediately after confirming key cleanup', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'grok',
      mode: 'api_key',
      credential_env: 'XAI_API_KEY',
      credential_present: true,
      modes: ['subscription', 'api_key', 'custom'],
      options: grokOptions,
    });
    const save = vi.spyOn(agentManagementApi, 'setAuthMode').mockResolvedValue({
      agent_id: 'grok',
      mode: 'subscription',
      credential_env: 'XAI_API_KEY',
      credential_present: false,
      modes: ['subscription', 'api_key', 'custom'],
      options: grokOptions,
    });
    vi.mocked(ConfirmDialog.show).mockResolvedValue('confirmed');
    const user = userEvent.setup();

    render(<AgentAuthModeControl agentId="grok" />);

    await pickAuthModeTab(user, '官方订阅');

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('grok', 'subscription', null)
    );
    expect(ConfirmDialog.show).toHaveBeenCalled();
    expect(
      screen.queryByText('订阅账号模式不会向进程传递 XAI_API_KEY。')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '保存鉴权模式' })
    ).not.toBeInTheDocument();
  });

  it('keeps an unsaved API key mode after the panel remounts', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'grok',
      mode: 'subscription',
      credential_env: 'XAI_API_KEY',
      credential_present: false,
      modes: ['subscription', 'api_key', 'custom'],
      options: grokOptions,
    });
    const user = userEvent.setup();

    const grokForm = (
      <div>
        <label>
          xAI API Key
          <input aria-label="xAI API Key" />
        </label>
        <label>
          自定义模型 ID
          <input aria-label="自定义模型 ID" />
        </label>
        <button type="button">读取模型</button>
      </div>
    );
    const { unmount } = render(
      <AgentAuthModeControl agentId="grok" configuration={grokForm} />
    );

    await pickAuthModeTab(user, '官方 API');
    expect(screen.getByRole('tab', { name: '官方 API' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByLabelText('xAI API Key')).toBeVisible();
    expect(screen.getByLabelText('API URL')).toHaveValue('https://api.x.ai/v1');
    expect(screen.getByLabelText('自定义模型 ID')).toBeVisible();
    expect(screen.getByRole('button', { name: '读取模型' })).toBeVisible();
    expect(screen.queryByLabelText('XAI_API_KEY')).not.toBeInTheDocument();

    unmount();
    render(<AgentAuthModeControl agentId="grok" configuration={grokForm} />);

    expect(
      await screen.findByRole('tab', { name: '官方 API' })
    ).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('xAI API Key')).toBeVisible();
  });

  it('does not treat browsing auth tabs as unsaved configuration', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'official_api',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: true,
      modes: ['official_subscription', 'official_api', 'model_provider'],
      options: claudeOptions,
    });
    const save = vi.spyOn(agentManagementApi, 'setAuthMode');
    const onDirtyChange = vi.fn();
    const user = userEvent.setup();

    render(
      <AgentAuthModeControl
        agentId="claude_code"
        onDirtyChange={onDirtyChange}
      />
    );

    await pickAuthModeTab(user, '供应商');
    await pickAuthModeTab(user, '官方 API');

    expect(save).not.toHaveBeenCalled();
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it('keeps the Codex API key inside the native configuration form', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'codex',
      mode: 'chatgpt_subscription',
      credential_env: 'OPENAI_API_KEY',
      credential_present: false,
      modes: ['chatgpt_subscription', 'api_key', 'model_provider'],
      options: codexOptions,
    });
    const save = vi.spyOn(agentManagementApi, 'setAuthMode').mockResolvedValue({
      agent_id: 'codex',
      mode: 'api_key',
      credential_env: 'OPENAI_API_KEY',
      credential_present: true,
      modes: ['chatgpt_subscription', 'api_key', 'model_provider'],
      options: codexOptions,
    });
    const user = userEvent.setup();

    render(
      <AgentAuthModeControl
        agentId="codex"
        configuration={<input aria-label="OpenAI API Key" />}
        nativeCredentialPresent={(fieldId) => fieldId === 'openai_api_key'}
      />
    );

    const tabs = await screen.findByRole('tablist', { name: 'Codex 鉴权模式' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.getAttribute('aria-label'))
    ).toEqual(['官方订阅', '官方 API', '供应商']);
    expect(screen.getByRole('tab', { name: '官方订阅' })).toBeVisible();
    expect(screen.getByRole('tab', { name: '供应商' })).toBeVisible();
    await pickAuthModeTab(user, '官方 API');
    expect(
      screen.getByLabelText('OpenAI API Key', { selector: 'input' })
    ).toBeVisible();
    expect(screen.queryByLabelText('OPENAI_API_KEY')).not.toBeInTheDocument();

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('codex', 'api_key', null)
    );
    expect(tabs).toBeInTheDocument();
  });

  it('keeps Claude credentials inside the native configuration form', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'official_subscription',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      modes: ['official_subscription', 'official_api', 'model_provider'],
      options: claudeOptions,
    });
    const save = vi.spyOn(agentManagementApi, 'setAuthMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'official_api',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: true,
      modes: ['official_subscription', 'official_api', 'model_provider'],
      options: claudeOptions,
    });
    const user = userEvent.setup();

    render(
      <AgentAuthModeControl
        agentId="claude_code"
        configuration={
          <label>
            API Key
            <input aria-label="API Key" />
          </label>
        }
        nativeCredentialPresent={(fieldId) => fieldId === 'anthropic_api_key'}
      />
    );

    expect(await screen.findByRole('tab', { name: '官方订阅' })).toBeVisible();
    await pickAuthModeTab(user, '官方 API');
    expect(screen.getByLabelText('API Key')).toBeVisible();
    expect(
      screen.queryByLabelText('ANTHROPIC_API_KEY')
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('API URL')).toHaveValue(
      'https://api.anthropic.com'
    );

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('claude_code', 'official_api', null)
    );
  });

  it('shows a session bar instead of duplicated login rows', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'official_subscription',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      modes: ['official_subscription', 'official_api', 'model_provider'],
      options: claudeOptions,
    });
    const save = vi.spyOn(agentManagementApi, 'setAuthMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'model_provider',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      modes: ['official_subscription', 'official_api', 'model_provider'],
      options: claudeOptions,
    });
    const user = userEvent.setup();

    render(
      <AgentAuthModeControl
        actions={claudeActions}
        agentId="claude_code"
        headingExtra={<div data-testid="auth-file-meta">settings.json</div>}
        configuration={
          <div data-testid="native-configuration">settings.json fields</div>
        }
        modelProvider={<div data-testid="model-provider">Provider fields</div>}
        onRunAction={vi.fn()}
      />
    );

    const region = await screen.findByRole('region', { name: '鉴权管理' });
    expect(region).toBeInTheDocument();
    expect(screen.getByText('未登录官方账号')).toBeVisible();
    expect(
      screen.getByRole('button', { name: '登录 Claude Code' })
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: '退出 Claude Code' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('请先安装或修复此 Agent。')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('当前没有可退出的账号会话。')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('运行 Claude Code 官方账号登录流程。')
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('auth-file-meta')).not.toBeInTheDocument();
    expect(screen.getByTestId('native-configuration')).not.toBeVisible();
    expect(screen.getByTestId('model-provider')).not.toBeVisible();
    expect(
      screen.queryByText('调用此 Agent 官方提供的账号管理流程')
    ).not.toBeInTheDocument();

    await pickAuthModeTab(user, '官方 API');
    expect(
      screen.queryByRole('button', { name: '登录 Claude Code' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('ANTHROPIC_API_KEY')
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('auth-file-meta')).toBeVisible();
    expect(
      screen
        .getByTestId('auth-file-meta')
        .compareDocumentPosition(
          screen.getByRole('tablist', { name: 'Claude Code 鉴权模式' })
        ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.getByTestId('native-configuration')).toBeVisible();
    expect(screen.getByTestId('model-provider')).not.toBeVisible();

    await pickAuthModeTab(user, '供应商');
    expect(
      screen.queryByLabelText('ANTHROPIC_API_KEY')
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('auth-file-meta')).not.toBeInTheDocument();
    expect(screen.getByTestId('native-configuration')).not.toBeVisible();
    expect(screen.getByTestId('model-provider')).toBeVisible();
    expect(save).not.toHaveBeenCalledWith(
      'claude_code',
      'model_provider',
      null
    );
  });

  it('opens the Codex Provider panel without requiring a bound preset', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'codex',
      mode: 'chatgpt_subscription',
      credential_env: 'OPENAI_API_KEY',
      credential_present: false,
      modes: ['chatgpt_subscription', 'api_key', 'model_provider'],
      options: codexOptions,
    });
    const save = vi.spyOn(agentManagementApi, 'setAuthMode');
    const user = userEvent.setup();

    render(
      <AgentAuthModeControl
        agentId="codex"
        modelProvider={<div data-testid="model-provider">Provider fields</div>}
      />
    );

    await pickAuthModeTab(user, '供应商');
    expect(screen.getByTestId('model-provider')).toBeVisible();
    expect(save).not.toHaveBeenCalled();
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
