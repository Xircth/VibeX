import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentManagementApi } from '@/features/agent-management';

import { clearAllAgentSettingsDrafts } from './agentSettingsDraftRetention';
import { pickAstryxOption } from './agentSettingsTestUtils';
import { AgentAuthModeControl } from './AgentAuthModeControl';

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
    'api_key',
    'authModeOpenAiKey',
    'authDescCodexKey',
    'OPENAI_API_KEY',
    'openai_api_key'
  ),
  authOption(
    'chatgpt_subscription',
    'authModeChatGpt',
    'authDescCodexSubscription'
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

  it('switches Grok to subscription and delegates credential cleanup', async () => {
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
    const user = userEvent.setup();

    render(<AgentAuthModeControl agentId="grok" />);

    const select = await screen.findByLabelText('Grok 鉴权模式');
    await pickAstryxOption(user, select, '官方订阅账号');
    await user.click(screen.getByRole('button', { name: '保存鉴权模式' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('grok', 'subscription', null)
    );
    expect(
      screen.queryByText('订阅账号模式不会向进程传递 XAI_API_KEY。')
    ).not.toBeInTheDocument();
  });

  it('keeps an unsaved custom endpoint after the panel remounts', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'grok',
      mode: 'api_key',
      credential_env: 'XAI_API_KEY',
      credential_present: true,
      modes: ['subscription', 'api_key', 'custom'],
      options: grokOptions,
    });
    const user = userEvent.setup();

    const { unmount } = render(<AgentAuthModeControl agentId="grok" />);

    await pickAstryxOption(
      user,
      await screen.findByLabelText('Grok 鉴权模式'),
      '自定义模型端点'
    );
    expect(screen.getByLabelText('Grok 鉴权模式')).toHaveTextContent(
      '自定义模型端点'
    );

    unmount();
    render(<AgentAuthModeControl agentId="grok" />);

    expect(await screen.findByLabelText('Grok 鉴权模式')).toHaveTextContent(
      '自定义模型端点'
    );
  });

  it('keeps the Codex API key inside the native configuration form', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'codex',
      mode: 'chatgpt_subscription',
      credential_env: 'OPENAI_API_KEY',
      credential_present: false,
      modes: ['api_key', 'chatgpt_subscription', 'model_provider'],
      options: codexOptions,
    });
    const save = vi.spyOn(agentManagementApi, 'setAuthMode').mockResolvedValue({
      agent_id: 'codex',
      mode: 'api_key',
      credential_env: 'OPENAI_API_KEY',
      credential_present: true,
      modes: ['api_key', 'chatgpt_subscription', 'model_provider'],
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

    const select = await screen.findByLabelText('Codex 鉴权模式');
    await user.click(select);
    expect(
      screen.getByRole('option', { name: 'ChatGPT 官方订阅' })
    ).toBeVisible();
    expect(
      screen.getByRole('option', { name: '已绑定 Model Provider' })
    ).toBeVisible();
    await user.click(screen.getByRole('option', { name: 'OpenAI API Key' }));
    expect(screen.getByLabelText('OpenAI API Key')).toBeVisible();
    expect(screen.queryByLabelText('OPENAI_API_KEY')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存鉴权模式' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('codex', 'api_key', null)
    );
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

    const select = await screen.findByLabelText('Claude Code 鉴权模式');
    await user.click(select);
    expect(screen.getByRole('option', { name: '官方订阅' })).toBeVisible();
    await user.click(screen.getByRole('option', { name: '自定义模型端点' }));
    expect(screen.getByLabelText('API Key')).toBeVisible();
    expect(
      screen.queryByLabelText('ANTHROPIC_API_KEY')
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存鉴权模式' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('claude_code', 'custom', null)
    );
  });

  it('shows only the workflow selected inside one authentication management region', async () => {
    vi.spyOn(agentManagementApi, 'authMode').mockResolvedValue({
      agent_id: 'claude_code',
      mode: 'official_subscription',
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
    const select = screen.getByLabelText('Claude Code 鉴权模式');
    expect(region).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '登录 Claude Code' })
    ).toBeVisible();
    expect(screen.getByText('请先安装或修复此 Agent。')).toBeVisible();
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

    await pickAstryxOption(user, select, '自定义模型端点');
    expect(
      screen.queryByRole('button', { name: '登录 Claude Code' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('ANTHROPIC_API_KEY')
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('auth-file-meta')).toBeVisible();
    expect(screen.getByTestId('native-configuration')).toBeVisible();
    expect(screen.getByTestId('model-provider')).not.toBeVisible();

    await pickAstryxOption(user, select, '已绑定 Model Provider');
    expect(
      screen.queryByLabelText('ANTHROPIC_API_KEY')
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('auth-file-meta')).not.toBeInTheDocument();
    expect(screen.getByTestId('native-configuration')).not.toBeVisible();
    expect(screen.getByTestId('model-provider')).toBeVisible();
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

    const select = await screen.findByLabelText('Gemini 鉴权模式');
    await user.click(select);
    expect(screen.getAllByRole('option')).toHaveLength(7);
    await user.click(screen.getByRole('option', { name: 'Vertex AI API Key' }));
    expect(screen.getByLabelText('Google API Key')).toBeVisible();
    expect(screen.queryByLabelText('GOOGLE_API_KEY')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存鉴权模式' }));

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
