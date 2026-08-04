import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentNativeConfigView } from 'shared/types';

import { AgentConfigurationAndDiagnostics } from './AgentConfigurationAndDiagnostics';

const config: AgentNativeConfigView = {
  agent_id: 'codex',
  available: true,
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
        '{\n  "OPENAI_API_KEY": "sk-local-only",\n  "tokens": {"access_token": "oauth-local"}\n}',
      sensitive: true,
      exists: true,
    },
    {
      path: '/Users/example/.codex/config.toml',
      format: 'toml',
      content:
        'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\nunknown = "preserved"\n',
      sensitive: false,
      exists: true,
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
    expect(
      screen.queryByText(/直接编辑 Agent 官方配置文件/)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '保存' })
    ).not.toBeInTheDocument();
    expect(screen.getByText(/unknown = "preserved"/)).toBeInTheDocument();
    expect(
      screen.getByLabelText('auth.json 配置文件预览，悬停或聚焦时显示')
    ).toHaveClass('is-sensitive');

    await userEvent.clear(screen.getByLabelText('模型'));
    await userEvent.type(screen.getByLabelText('模型'), 'gpt-5.6');
    await userEvent.selectOptions(screen.getByLabelText('推理强度'), 'high');
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

  it('keeps secret replacement and removal explicit', async () => {
    const onSave = vi.fn();
    render(
      <AgentConfigurationAndDiagnostics
        config={config}
        saving={false}
        onSave={onSave}
      />
    );

    expect(screen.getByText('••••••••')).toBeInTheDocument();
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
});
