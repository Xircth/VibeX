import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentManagementApi } from '@/features/agent-management';

import { AgentAuthModeControl } from './AgentAuthModeControl';

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
    'OPENAI_API_KEY'
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
    'ANTHROPIC_API_KEY'
  ),
  authOption('model_provider', 'authModeProvider', 'authDescClaudeProvider'),
];
const geminiOptions = [
  authOption(
    'custom',
    'authModeCustomEndpoint',
    'authDescGeminiCustom',
    'GEMINI_API_KEY'
  ),
  authOption('login_google', 'authModeGoogleLogin', 'authDescGeminiGoogle'),
  authOption(
    'gemini_api_key',
    'authModeGeminiKey',
    'authDescGeminiKey',
    'GEMINI_API_KEY'
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
    'GOOGLE_API_KEY'
  ),
  authOption('model_provider', 'authModeProvider', 'authDescGeminiProvider'),
];

describe('AgentAuthModeControl', () => {
  afterEach(() => vi.restoreAllMocks());

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

    await user.selectOptions(
      await screen.findByLabelText('Grok 鉴权模式'),
      'subscription'
    );
    await user.click(screen.getByRole('button', { name: '保存鉴权模式' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('grok', 'subscription', null)
    );
    expect(
      screen.getByText('订阅账号模式不会向进程传递 XAI_API_KEY。')
    ).toBeInTheDocument();
  });

  it('exposes all Codex authentication modes and requires a key only for API mode', async () => {
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

    render(<AgentAuthModeControl agentId="codex" />);

    const select = await screen.findByLabelText('Codex 鉴权模式');
    expect(
      screen.getByRole('option', { name: 'ChatGPT 官方订阅' })
    ).toBeVisible();
    expect(
      screen.getByRole('option', { name: '已绑定 Model Provider' })
    ).toBeVisible();
    await user.selectOptions(select, 'api_key');
    await user.type(screen.getByLabelText('OPENAI_API_KEY'), 'sk-local');
    await user.click(screen.getByRole('button', { name: '保存鉴权模式' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('codex', 'api_key', 'sk-local')
    );
  });

  it('exposes Claude subscription, custom endpoint, and Provider modes', async () => {
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

    render(<AgentAuthModeControl agentId="claude_code" />);

    const select = await screen.findByLabelText('Claude Code 鉴权模式');
    expect(screen.getByRole('option', { name: '官方订阅' })).toBeVisible();
    await user.selectOptions(select, 'custom');
    await user.type(screen.getByLabelText('ANTHROPIC_API_KEY'), 'sk-ant-local');
    await user.click(screen.getByRole('button', { name: '保存鉴权模式' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('claude_code', 'custom', 'sk-ant-local')
    );
  });

  it('exposes all seven Gemini modes and maps the Vertex credential correctly', async () => {
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

    render(<AgentAuthModeControl agentId="gemini" />);

    const select = await screen.findByLabelText('Gemini 鉴权模式');
    expect(screen.getAllByRole('option')).toHaveLength(7);
    await user.selectOptions(select, 'vertex_api_key');
    await user.type(screen.getByLabelText('GOOGLE_API_KEY'), 'vertex-key');
    await user.click(screen.getByRole('button', { name: '保存鉴权模式' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        'gemini',
        'vertex_api_key',
        'vertex-key'
      )
    );
  });
});

function authOption(
  value: string,
  label: string,
  description: string,
  credentialEnv?: string
) {
  return {
    value,
    label_key: `agents.${label}`,
    description_key: `agents.${description}`,
    credential_env: credentialEnv ?? null,
    credential_required: credentialEnv !== undefined,
  };
}
