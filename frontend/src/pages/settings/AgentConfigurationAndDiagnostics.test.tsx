import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentNativeConfigView } from 'shared/types';

import { desktopApi } from '@/lib/api';

import { pickAstryxOption } from './agentSettingsTestUtils';
import { AgentConfigurationAndDiagnostics } from './AgentConfigurationAndDiagnostics';

const config: AgentNativeConfigView = {
  agent_id: 'codex',
  available: true,
  settings_features: [
    'authentication_mode',
    'model_catalog',
    'reusable_model_providers',
    'codex_model_catalog',
    'native_skills',
  ],
  path: '/Users/example/.codex/auth.json',
  paths: [
    '/Users/example/.codex/auth.json',
    '/Users/example/.codex/config.toml',
  ],
  files: [
    {
      path: '/Users/example/.codex/auth.json',
      format: 'json',
      content:
        '{\n  "OPENAI_API_KEY": "sk-real-local-key",\n  "tokens": {"access_token": "oauth-real-token"}\n}',
      sensitive: true,
      exists: true,
      revision: 'revision-auth-file',
    },
    {
      path: '/Users/example/.codex/config.toml',
      format: 'toml',
      content:
        'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\nunknown = "preserved"\n',
      sensitive: false,
      exists: true,
      revision: 'revision-config-file',
    },
  ],
  applies_to_next_session: true,
  fields: [
    {
      id: 'openai_api_key',
      label: 'OpenAI API Key',
      description: '写入 Codex 的本地认证文件',
      kind: 'secret',
      options: [],
      secret: true,
      path: '/Users/example/.codex/auth.json',
      present: true,
      value: null,
      masked_value: '••••••••',
      revision: 'revision-key',
    },
    {
      id: 'codex_model',
      label: '模型',
      description: 'Codex 默认模型',
      kind: 'text',
      options: [],
      secret: false,
      path: '/Users/example/.codex/config.toml',
      present: true,
      value: 'gpt-5.4',
      masked_value: null,
      revision: 'revision-model',
    },
    {
      id: 'codex_reasoning_effort',
      label: '推理强度',
      description: 'Codex 模型的 reasoning effort',
      kind: 'select',
      options: [
        { value: 'medium', label: '中' },
        { value: 'high', label: '高' },
      ],
      secret: false,
      path: '/Users/example/.codex/config.toml',
      present: true,
      value: 'medium',
      masked_value: null,
      revision: 'revision-effort',
    },
  ],
};

describe('AgentConfigurationAndDiagnostics', () => {
  it('renders official Runtime fields and saves only changed values', async () => {
    const onSave = vi.fn();
    render(
      <AgentConfigurationAndDiagnostics
        config={config}
        saving={false}
        onSave={onSave}
      />
    );

    expect(screen.getByDisplayValue('gpt-5.4')).toBeInTheDocument();
    expect(screen.getByText('config.toml')).toBeInTheDocument();
    expect(screen.queryByText('诊断记录')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Codex 模型的 reasoning effort')
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('推理强度')).not.toHaveAttribute(
      'aria-describedby'
    );
    expect(
      screen.queryByText('写入 Codex 的本地认证文件')
    ).not.toBeInTheDocument();
    expect(screen.getByText('高级原生文件编辑器')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '保存' })
    ).not.toBeInTheDocument();
    expect(screen.getAllByText(/unknown = "preserved"/)).toHaveLength(2);
    const sensitivePreview = screen.getByLabelText('auth.json 配置预览');
    expect(sensitivePreview).toHaveClass('is-sensitive');
    expect(sensitivePreview).toHaveAttribute('tabindex', '0');
    expect(sensitivePreview).toHaveTextContent('OPENAI_API_KEY');
    expect(sensitivePreview).toHaveTextContent('sk-real-local-key');
    expect(sensitivePreview).toHaveTextContent('oauth-real-token');
    expect(screen.queryByText(/sk-local-only/)).not.toBeInTheDocument();
    expect(screen.queryByText('可复用 Model Provider')).not.toBeInTheDocument();
    expect(screen.queryByText('Agent Skills')).not.toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('模型'));
    await userEvent.type(screen.getByLabelText('模型'), 'gpt-5.6');
    await pickAstryxOption(userEvent, screen.getByLabelText('推理强度'), '高');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSave).toHaveBeenCalledWith({
      agent_id: 'codex',
      base_field_revisions: {
        codex_model: 'revision-model',
        codex_reasoning_effort: 'revision-effort',
      },
      fields: {
        codex_model: 'gpt-5.6',
        codex_reasoning_effort: 'high',
      },
    });
  });

  it('edits a validated non-sensitive native file with its revision', async () => {
    const onSaveFile = vi.fn();
    render(
      <AgentConfigurationAndDiagnostics
        config={config}
        saving={false}
        onSave={vi.fn()}
        onSaveFile={onSaveFile}
      />
    );

    await userEvent.click(screen.getByText('高级原生文件编辑器'));
    const editor = screen.getByLabelText('编辑 config.toml');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'model = "gpt-5.6"');
    await userEvent.click(screen.getByRole('button', { name: '保存文件' }));

    expect(onSaveFile).toHaveBeenCalledWith({
      agent_id: 'codex',
      path: '/Users/example/.codex/config.toml',
      base_revision: 'revision-config-file',
      content: 'model = "gpt-5.6"',
    });
    expect(screen.queryByLabelText('编辑 auth.json')).not.toBeInTheDocument();
  });

  it('opens the containing folder from each configuration file row', async () => {
    const reveal = vi
      .spyOn(desktopApi, 'revealInFileManager')
      .mockResolvedValue(undefined);
    render(
      <AgentConfigurationAndDiagnostics
        config={config}
        saving={false}
        onSave={vi.fn()}
      />
    );

    await userEvent.click(
      screen.getByRole('button', { name: '打开 auth.json 所在目录' })
    );
    expect(reveal).toHaveBeenNthCalledWith(1, '/Users/example/.codex');
    await userEvent.click(
      screen.getByRole('button', { name: '打开 config.toml 所在目录' })
    );
    expect(reveal).toHaveBeenNthCalledWith(2, '/Users/example/.codex');
    reveal.mockRestore();
  });

  it('keeps secret replacement and removal explicit', async () => {
    const onSave = vi.fn();
    render(
      <AgentConfigurationAndDiagnostics
        config={config}
        saving={false}
        onSave={onSave}
      />
    );

    expect(screen.getByLabelText('OpenAI API Key')).toHaveValue('••••••••');
    await userEvent.type(
      screen.getByLabelText('OpenAI API Key'),
      'sk-local-only'
    );
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledWith({
      agent_id: 'codex',
      base_field_revisions: { openai_api_key: 'revision-key' },
      fields: { openai_api_key: 'sk-local-only' },
    });

    await userEvent.click(
      screen.getByRole('button', { name: '移除 OpenAI API Key' })
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenLastCalledWith({
      agent_id: 'codex',
      base_field_revisions: { openai_api_key: 'revision-key' },
      fields: { openai_api_key: null },
    });
  });

  it('offers reload, adopt-external, and explicit overwrite after a conflict', async () => {
    const onReloadConflict = vi.fn();
    const onAdoptExternal = vi.fn();
    const onOverwriteConflict = vi.fn();
    render(
      <AgentConfigurationAndDiagnostics
        config={config}
        saving={false}
        conflictMessage="配置字段已被外部修改：codex_model"
        onSave={vi.fn()}
        onReloadConflict={onReloadConflict}
        onAdoptExternal={onAdoptExternal}
        onOverwriteConflict={onOverwriteConflict}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('配置字段已被外部修改');
    await userEvent.click(screen.getByRole('button', { name: '重新加载' }));
    await userEvent.click(screen.getByRole('button', { name: '采用外部值' }));
    await userEvent.click(screen.getByRole('button', { name: '覆盖外部修改' }));
    expect(onReloadConflict).toHaveBeenCalledOnce();
    expect(onAdoptExternal).toHaveBeenCalledOnce();
    expect(onOverwriteConflict).toHaveBeenCalledOnce();
  });

  it('shows only the credential fields relevant to the selected Hermes provider', async () => {
    const hermesConfig: AgentNativeConfigView = {
      agent_id: 'hermes',
      available: true,
      settings_features: [],
      path: '/Users/example/.hermes/config.yaml',
      paths: [
        '/Users/example/.hermes/config.yaml',
        '/Users/example/.hermes/.env',
      ],
      files: [],
      applies_to_next_session: true,
      fields: [
        {
          id: 'hermes_provider',
          label: 'Provider',
          description: '',
          kind: 'select',
          options: [
            { value: 'openrouter', label: 'OpenRouter' },
            { value: 'anthropic', label: 'Anthropic' },
          ],
          secret: false,
          path: '/Users/example/.hermes/config.yaml',
          present: true,
          value: 'openrouter',
          masked_value: null,
          revision: 'provider-revision',
        },
        {
          id: 'hermes_model',
          label: '模型',
          description: '',
          kind: 'text',
          options: [],
          secret: false,
          path: '/Users/example/.hermes/config.yaml',
          present: false,
          value: null,
          masked_value: null,
          revision: 'model-revision',
        },
        {
          id: 'hermes_openrouter_key',
          label: 'OpenRouter API Key',
          description: '',
          kind: 'secret',
          options: [],
          secret: true,
          path: '/Users/example/.hermes/.env',
          present: false,
          value: null,
          masked_value: null,
          revision: 'openrouter-revision',
        },
        {
          id: 'hermes_anthropic_key',
          label: 'Anthropic API Key',
          description: '',
          kind: 'secret',
          options: [],
          secret: true,
          path: '/Users/example/.hermes/.env',
          present: false,
          value: null,
          masked_value: null,
          revision: 'anthropic-revision',
        },
      ],
    };

    render(
      <AgentConfigurationAndDiagnostics
        config={hermesConfig}
        saving={false}
        onSave={vi.fn()}
      />
    );

    expect(screen.getByLabelText('OpenRouter API Key')).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Anthropic API Key')
    ).not.toBeInTheDocument();

    await pickAstryxOption(
      userEvent,
      screen.getByLabelText('Provider'),
      'Anthropic'
    );

    expect(screen.getByLabelText('Anthropic API Key')).toBeInTheDocument();
    expect(
      screen.queryByLabelText('OpenRouter API Key')
    ).not.toBeInTheDocument();
  });

  it('reveals Codex granular approvals and saves an explicit five-part policy', async () => {
    const onSave = vi.fn();
    const granularFields = [
      ['codex_approval_sandbox', '沙箱命令确认'],
      ['codex_approval_rules', '规则确认'],
      ['codex_approval_skills', 'Skill 确认'],
      ['codex_approval_permissions', '权限请求确认'],
      ['codex_approval_mcp', 'MCP 交互确认'],
    ].map(([id, label]) => ({
      id,
      label,
      description: '',
      kind: 'boolean' as const,
      options: [],
      secret: false,
      path: '/Users/example/.codex/config.toml',
      present: false,
      value: null,
      masked_value: null,
      revision: `${id}-revision`,
    }));
    render(
      <AgentConfigurationAndDiagnostics
        config={{
          ...config,
          fields: [
            ...config.fields,
            {
              id: 'codex_approval_policy',
              label: '命令确认',
              description: '',
              kind: 'select',
              options: [
                { value: 'on-request', label: '按需确认' },
                { value: 'granular', label: '按能力分别确认' },
              ],
              secret: false,
              path: '/Users/example/.codex/config.toml',
              present: true,
              value: 'on-request',
              masked_value: null,
              revision: 'policy-revision',
            },
            ...granularFields,
          ],
        }}
        saving={false}
        onSave={onSave}
      />
    );

    expect(screen.queryByLabelText('沙箱命令确认')).not.toBeInTheDocument();
    await pickAstryxOption(
      userEvent,
      screen.getByLabelText('命令确认'),
      '按能力分别确认'
    );
    expect(screen.getByLabelText('沙箱命令确认')).toBeChecked();
    await userEvent.click(screen.getByLabelText('规则确认'));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSave).toHaveBeenCalledWith({
      agent_id: 'codex',
      base_field_revisions: {
        codex_approval_policy: 'policy-revision',
        codex_approval_rules: 'codex_approval_rules-revision',
      },
      fields: {
        codex_approval_policy: 'granular',
        codex_approval_rules: 'false',
      },
    });
  });

  it('renders Codex quick toggles and saves their state', async () => {
    const onSave = vi.fn();
    render(
      <AgentConfigurationAndDiagnostics
        config={{
          ...config,
          fields: [
            ...config.fields,
            {
              id: 'codex_skills',
              label: 'Skills',
              description: '',
              kind: 'boolean',
              options: [],
              secret: false,
              path: '/Users/example/.codex/config.toml',
              present: true,
              value: 'false',
              masked_value: null,
              revision: 'skills-revision',
            },
            {
              id: 'codex_network_access',
              label: '沙箱网络访问',
              description: '',
              kind: 'boolean',
              options: [],
              secret: false,
              path: '/Users/example/.codex/config.toml',
              present: true,
              value: 'false',
              masked_value: null,
              revision: 'network-revision',
            },
          ],
        }}
        saving={false}
        onSave={onSave}
      />
    );

    await userEvent.click(screen.getByLabelText('Skills'));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSave).toHaveBeenCalledWith({
      agent_id: 'codex',
      base_field_revisions: { codex_skills: 'skills-revision' },
      fields: { codex_skills: 'true' },
    });
  });
});
