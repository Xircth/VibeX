import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    'authModeSubscription',
    'authDescGrokSubscription'
  ),
  authOption('api_key', 'authModeXaiKey', 'authDescGrokKey', 'XAI_API_KEY'),
  authOption('custom', 'authModeCustomEndpoint', 'authDescGrokCustom'),
];
const codexOptions = [
  authOption(
    'chatgpt_subscription',
    'authModeChatGpt',
    'authDescCodexSubscription'
  ),
  authOption(
    'api_key',
    'authModeOpenAiKey',
    'authDescCodexKey',
    'OPENAI_API_KEY',
    'openai_api_key'
  ),
  authOption('model_provider', 'authModeProvider', 'authDescCodexProvider'),
];
const claudeOptions = [
  authOption(
    'official_subscription',
    'authModeOfficialSubscription',
    'authDescClaudeSubscription'
  ),
  authOption(
    'custom',
    'authModeCustomEndpoint',
    'authDescClaudeCustom',
    'ANTHROPIC_API_KEY',
    'anthropic_api_key'
  ),
  authOption('model_provider', 'authModeProvider', 'authDescClaudeProvider'),
];
const geminiOptions = [
  authOption(
    'custom',
    'authModeCustomEndpoint',
    'authDescGeminiCustom',
    'GEMINI_API_KEY',
    'gemini_api_key'
  ),
  authOption('login_google', 'authModeGoogleLogin', 'authDescGeminiGoogle'),
  authOption(
    'gemini_api_key',
    'authModeGeminiKey',
    'authDescGeminiKey',
    'GEMINI_API_KEY',
    'gemini_api_key'
  ),
  authOption('vertex_adc', 'authModeVertexAdc', 'authDescGeminiAdc'),
  authOption(
    'vertex_service_account',
    'authModeVertexServiceAccount',
    'authDescGeminiServiceAccount'
  ),
  authOption(
    'vertex_api_key',
    'authModeVertexKey',
    'authDescGeminiVertexKey',
    'GOOGLE_API_KEY',
    'gemini_google_api_key'
  ),
  authOption('model_provider', 'authModeProvider', 'authDescGeminiProvider'),
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

    await pickAuthModeTab(user, '官方订阅账号');

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

    const { unmount } = render(<AgentAuthModeControl agentId="grok" />);

    await pickAuthModeTab(user, 'xAI API Key');
    expect(screen.getByRole('tab', { name: 'xAI API Key' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByLabelText('XAI_API_KEY')).toBeVisible();

    unmount();
    render(<AgentAuthModeControl agentId="grok" />);

    expect(
      await screen.findByRole('tab', { name: 'xAI API Key' })
    ).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('XAI_API_KEY')).toBeVisible();
  });

  it('notifies the parent only after an API key is saved', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'grok',
      mode: 'subscription',
      credential_env: 'XAI_API_KEY',
      credential_present: false,
      modes: ['subscription', 'api_key', 'custom'],
      options: grokOptions,
    });
    const save = vi.spyOn(agentManagementApi, 'setAuthMode').mockResolvedValue({
      agent_id: 'grok',
      mode: 'api_key',
      credential_env: 'XAI_API_KEY',
      credential_present: true,
      modes: ['subscription', 'api_key', 'custom'],
      options: grokOptions,
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();

    render(<AgentAuthModeControl agentId="grok" onChanged={onChanged} />);

    await pickAuthModeTab(user, 'xAI API Key');
    expect(onChanged).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('XAI_API_KEY'), 'xai-key');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('grok', 'api_key', 'xai-key')
    );
    expect(onChanged).toHaveBeenCalledOnce();
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
    ).toEqual(['ChatGPT 官方订阅', 'OpenAI API Key', '已绑定 Model Provider']);
    expect(screen.getByRole('tab', { name: 'ChatGPT 官方订阅' })).toBeVisible();
    expect(
      screen.getByRole('tab', { name: '已绑定 Model Provider' })
    ).toBeVisible();
    await pickAuthModeTab(user, 'OpenAI API Key');
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
      modes: ['official_subscription', 'custom', 'model_provider'],
      options: claudeOptions,
    });
    const save = vi.spyOn(agentManagementApi, 'setAuthMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'custom',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: true,
      modes: ['official_subscription', 'custom', 'model_provider'],
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
    await pickAuthModeTab(user, '自定义模型端点');
    expect(screen.getByLabelText('API Key')).toBeVisible();
    expect(
      screen.queryByLabelText('ANTHROPIC_API_KEY')
    ).not.toBeInTheDocument();

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('claude_code', 'custom', null)
    );
  });

  it('shows a session bar instead of duplicated login rows', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'official_subscription',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      modes: ['official_subscription', 'custom', 'model_provider'],
      options: claudeOptions,
    });
    const save = vi.spyOn(agentManagementApi, 'setAuthMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'model_provider',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      modes: ['official_subscription', 'custom', 'model_provider'],
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

    await pickAuthModeTab(user, '自定义模型端点');
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

    await pickAuthModeTab(user, '已绑定 Model Provider');
    expect(
      screen.queryByLabelText('ANTHROPIC_API_KEY')
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('auth-file-meta')).not.toBeInTheDocument();
    expect(screen.getByTestId('native-configuration')).not.toBeVisible();
    expect(screen.getByTestId('model-provider')).toBeVisible();
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('claude_code', 'model_provider', null)
    );
  });

  it('hides login and shows logout when the official account is signed in', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'official_subscription',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      account_label: 'linus@example.com',
      modes: ['official_subscription', 'custom', 'model_provider'],
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

    expect(
      await screen.findByText('当前登录账户：linus@example.com')
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: '登录 Claude Code' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '退出 Claude Code' })
    ).toBeVisible();
  });

  it('falls back to signed-in copy when the account name is unknown', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'official_subscription',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      modes: ['official_subscription', 'custom', 'model_provider'],
      options: claudeOptions,
    });

    render(
      <AgentAuthModeControl agentId="claude_code" authentication="account" />
    );

    expect(await screen.findByText('当前已登录')).toBeVisible();
  });

  it('shows login after logout even when the logout command is still available', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'official_subscription',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_present: false,
      modes: ['official_subscription', 'custom', 'model_provider'],
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

  it('maps all Gemini credentials to the native configuration form', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'gemini',
      mode: 'login_google',
      credential_env: 'GEMINI_API_KEY',
      credential_present: false,
      modes: [
        'custom',
        'login_google',
        'gemini_api_key',
        'vertex_adc',
        'vertex_service_account',
        'vertex_api_key',
        'model_provider',
      ],
      options: geminiOptions,
    });
    const save = vi.spyOn(agentManagementApi, 'setAuthMode').mockResolvedValue({
      agent_id: 'gemini',
      mode: 'vertex_api_key',
      credential_env: 'GOOGLE_API_KEY',
      credential_present: true,
      modes: [
        'custom',
        'login_google',
        'gemini_api_key',
        'vertex_adc',
        'vertex_service_account',
        'vertex_api_key',
        'model_provider',
      ],
      options: geminiOptions,
    });
    const user = userEvent.setup();

    render(
      <AgentAuthModeControl
        agentId="gemini"
        configuration={<input aria-label="Google API Key" />}
        nativeCredentialPresent={(fieldId) =>
          fieldId === 'gemini_google_api_key'
        }
      />
    );

    expect(
      await screen.findByRole('tablist', { name: 'Gemini 鉴权模式' })
    ).toBeVisible();
    expect(screen.getAllByRole('tab')).toHaveLength(7);
    await pickAuthModeTab(user, 'Vertex AI API Key');
    expect(screen.getByLabelText('Google API Key')).toBeVisible();
    expect(screen.queryByLabelText('GOOGLE_API_KEY')).not.toBeInTheDocument();

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('gemini', 'vertex_api_key', null)
    );
  });
});

function authOption(
  value: string,
  label: string,
  description: string,
  credentialEnv?: string,
  nativeConfigFieldId?: string
) {
  return {
    value,
    label_key: `agents.${label}`,
    description_key: `agents.${description}`,
    credential_env: credentialEnv ?? null,
    credential_required: credentialEnv !== undefined,
    native_config_field_id: nativeConfigFieldId ?? null,
  };
}
