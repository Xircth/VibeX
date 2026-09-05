import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRegistryView, CommunityAcpPresetView } from 'shared/types';

import { AgentRegistryViewPanel } from './AgentRegistryView';

const view: AgentRegistryView = {
  current_platform: 'darwin-aarch64',
  snapshot_id: 'snapshot-1',
  fetched_at: '2026-07-29T12:00:00Z',
  fresh: true,
  refresh_error: null,
  installed: [
    {
      agent_id: 'codex',
      registry_id: 'codex-acp',
      display_name: 'Codex',
      description: 'Codex ACP',
      authors: ['OpenAI'],
      version: '1.0.0',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      built_in: true,
      added: true,
      installed: true,
      platform_supported: true,
    },
    {
      agent_id: 'alpha',
      registry_id: 'alpha',
      display_name: 'Alpha',
      description: 'Alpha ACP',
      authors: ['Acme Labs'],
      version: '1.0.0',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      built_in: false,
      added: true,
      installed: false,
      platform_supported: true,
    },
  ],
  uninstalled: [
    {
      agent_id: 'zeta',
      registry_id: 'zeta',
      display_name: 'Zeta',
      description: 'Zeta ACP',
      authors: ['Zed Industries'],
      version: '2.0.0',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      built_in: false,
      added: false,
      installed: false,
      platform_supported: true,
    },
    {
      agent_id: 'beta',
      registry_id: 'beta',
      display_name: 'Beta',
      description: 'Beta ACP',
      authors: ['Beta Works'],
      version: '1.0.0',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      built_in: false,
      added: false,
      installed: false,
      platform_supported: false,
    },
  ],
  presets: [],
};

const deepseekPreset: CommunityAcpPresetView = {
  preset_id: 'deepseek-acp',
  agent_id: 'deepseek_harness',
  display_name: 'DeepSeek Harness',
  description: 'Community ACP adapter for DeepSeek Harness',
  authors: ['xintaofei'],
  repository: 'https://github.com/xintaofei/deepseek-acp',
  version: '0.3.0',
  distribution_kind: 'npx',
  distribution_json:
    '{"npx":{"package":"deepseek-acp@0.3.0","args":[],"env":{}}}',
  icon_light: '/agents/deepseek-harness.svg',
  icon_dark: '/agents/deepseek-harness.svg',
  built_in: true,
  added: true,
};

describe('AgentRegistryViewPanel', () => {
  it('exposes one searchable control and compact installation statuses', async () => {
    render(
      <AgentRegistryViewPanel
        view={view}
        loading={false}
        addingAgentId={null}
        onRefresh={vi.fn()}
        onAdd={vi.fn()}
        onAddUserDefinition={vi.fn()}
      />
    );

    const search = screen.getByRole('searchbox', { name: '搜索 Agent' });
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
    expect(screen.getAllByRole('status')).toHaveLength(
      view.installed.length + 1
    );

    await userEvent.type(search, 'Alpha');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Alpha')).toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, 'OpenAI');
    expect(screen.getByText('Codex', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  it('discloses snapshot freshness and blocks stale installation', async () => {
    render(
      <AgentRegistryViewPanel
        view={{ ...view, fresh: false }}
        loading={false}
        addingAgentId={null}
        onRefresh={vi.fn()}
        onAdd={vi.fn()}
        onAddUserDefinition={vi.fn()}
      />
    );

    expect(
      screen.getByRole('status', { name: '注册表缓存已过期' })
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /未安装/ }));
    expect(screen.getByRole('button', { name: '安装 Zeta' })).toBeDisabled();
  });

  it('separates independently sorted tabs and adds supported Agents inline', async () => {
    const onAdd = vi.fn();
    render(
      <AgentRegistryViewPanel
        view={view}
        loading={false}
        addingAgentId={null}
        onRefresh={vi.fn()}
        onAdd={onAdd}
        onAddUserDefinition={vi.fn()}
      />
    );

    expect(
      screen.getAllByRole('listitem').map((row) => row.textContent)
    ).toEqual([
      expect.stringContaining('Codex'),
      expect.stringContaining('Alpha'),
    ]);

    await userEvent.click(screen.getByRole('tab', { name: /未安装/ }));
    expect(
      screen.getAllByRole('listitem').map((row) => row.textContent)
    ).toEqual([
      expect.stringContaining('Beta'),
      expect.stringContaining('Zeta'),
    ]);
    expect(screen.getByRole('button', { name: '安装 Beta' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '安装 Zeta' }));
    expect(onAdd).toHaveBeenCalledWith(view.uninstalled[0]);
  });

  it('builds a Registry-compatible definition from structured launch fields', async () => {
    const onAddUserDefinition = vi.fn();
    render(
      <AgentRegistryViewPanel
        view={view}
        loading={false}
        addingAgentId={null}
        onRefresh={vi.fn()}
        onAdd={vi.fn()}
        onAddUserDefinition={onAddUserDefinition}
      />
    );

    await userEvent.click(screen.getByRole('tab', { name: '手动添加' }));
    await userEvent.type(screen.getByLabelText('Agent ID'), 'local-reviewer');
    await userEvent.type(screen.getByLabelText('显示名称'), 'Local Reviewer');
    await userEvent.type(screen.getByLabelText('版本'), '1.2.3');
    await userEvent.type(
      screen.getByLabelText('软件包'),
      'local-reviewer@1.2.3'
    );
    await userEvent.clear(screen.getByLabelText('启动参数'));
    await userEvent.type(
      screen.getByLabelText('启动参数'),
      '--acp{enter}--strict'
    );
    await userEvent.type(screen.getByLabelText('环境变量名称 1'), 'ACP_MODE');
    await userEvent.type(screen.getByLabelText('环境变量值 1'), 'review');
    await userEvent.click(screen.getByRole('button', { name: '添加并安装' }));

    expect(onAddUserDefinition).toHaveBeenCalledWith({
      agent_id: 'local-reviewer',
      display_name: 'Local Reviewer',
      description: '',
      version: '1.2.3',
      distribution_kind: 'npx',
      distribution_json: JSON.stringify({
        npx: {
          package: 'local-reviewer@1.2.3',
          args: ['--acp', '--strict'],
          env: { ACP_MODE: 'review' },
        },
      }),
      skills_shared_store: false,
      skills_directory: null,
    });
  });

  it('shows community ACP presets on the manual tab', async () => {
    const onAddUserDefinition = vi.fn();
    render(
      <AgentRegistryViewPanel
        view={{ ...view, presets: [deepseekPreset] }}
        loading={false}
        addingAgentId={null}
        onRefresh={vi.fn()}
        onAdd={vi.fn()}
        onAddUserDefinition={onAddUserDefinition}
      />
    );

    await userEvent.click(screen.getByRole('tab', { name: '手动添加' }));
    expect(screen.getByText('预设 ACP')).toBeInTheDocument();
    // The agent icon carries the same name in an SVG <title> for screen
    // readers, so match the visible row label rather than every text node.
    expect(
      screen.getByText('DeepSeek Harness', { selector: 'span' })
    ).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '已内置' })).toBeInTheDocument();
    expect(onAddUserDefinition).not.toHaveBeenCalled();
  });

  it('adds an available community ACP preset without filling the form', async () => {
    const onAddUserDefinition = vi.fn();
    render(
      <AgentRegistryViewPanel
        view={{
          ...view,
          presets: [{ ...deepseekPreset, built_in: false, added: false }],
        }}
        loading={false}
        addingAgentId={null}
        onRefresh={vi.fn()}
        onAdd={vi.fn()}
        onAddUserDefinition={onAddUserDefinition}
      />
    );

    await userEvent.click(screen.getByRole('tab', { name: '手动添加' }));
    await userEvent.click(
      screen.getByRole('button', { name: '安装 DeepSeek Harness' })
    );
    expect(onAddUserDefinition).toHaveBeenCalledWith({
      agent_id: 'deepseek_harness',
      display_name: 'DeepSeek Harness',
      description: 'Community ACP adapter for DeepSeek Harness',
      version: '0.3.0',
      distribution_kind: 'npx',
      distribution_json: deepseekPreset.distribution_json,
      skills_shared_store: true,
      skills_directory: null,
    });
  });
});
