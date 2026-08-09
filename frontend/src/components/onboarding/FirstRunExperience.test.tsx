import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorType, type AgentManagementView } from 'shared/types';

import i18n from '@/i18n';

import { FirstRunExperience } from './FirstRunExperience';

const managementMock = vi.hoisted(() => ({
  bar: vi.fn(),
  refreshBar: vi.fn(),
  registry: vi.fn(),
  refreshRegistry: vi.fn(),
  setEnabled: vi.fn(),
  addAndInstall: vi.fn(),
  preflight: vi.fn(),
}));

const configApiMock = vi.hoisted(() => ({
  checkEditorAvailability: vi.fn(),
}));

const animationMock = vi.hoisted(() => {
  const timeline = {
    fromTo: vi.fn(),
    to: vi.fn(),
  };
  timeline.fromTo.mockReturnValue(timeline);
  timeline.to.mockReturnValue(timeline);

  const gsap = {
    registerPlugin: vi.fn(),
    matchMedia: vi.fn(() => ({
      add: vi.fn((query: string, callback: () => void) => {
        if (query.includes('no-preference')) callback();
      }),
      revert: vi.fn(),
    })),
    timeline: vi.fn(() => timeline),
    fromTo: vi.fn(),
    to: vi.fn(),
    set: vi.fn(),
  };

  return {
    callback: null as (() => void) | null,
    gsap,
    timeline,
  };
});

vi.mock('@/features/agent-management', () => ({
  agentManagementApi: managementMock,
}));

vi.mock('@/lib/api', () => ({
  configApi: configApiMock,
  settingsWindowApi: { open: vi.fn() },
}));

vi.mock('@/lib/backendTransport', () => ({
  backendListen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

vi.mock('@gsap/react', () => ({
  useGSAP: (callback: () => void) => {
    animationMock.callback = callback;
  },
}));

vi.mock('gsap', () => ({
  default: animationMock.gsap,
}));

function agent(
  overrides: Partial<AgentManagementView> &
    Pick<AgentManagementView, 'agent_id' | 'display_name'>
): AgentManagementView {
  return {
    description: '',
    icon_light: null,
    icon_dark: null,
    icon_svg: null,
    source: 'built_in_profile',
    built_in: true,
    retired: false,
    enabled: false,
    position: 0,
    lifecycle: 'uninstalled',
    authentication: 'not_logged_in',
    runtime_version: null,
    acp_version: null,
    active_operation: null,
    rollback_available: false,
    ...overrides,
  };
}

const editor = {
  editor_type: EditorType.VS_CODE,
  custom_command: null,
  remote_ssh_host: null,
  remote_ssh_user: null,
};

describe('FirstRunExperience', () => {
  beforeEach(() => {
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    animationMock.callback = null;
    animationMock.gsap.to.mockClear();
    animationMock.gsap.fromTo.mockClear();
    animationMock.gsap.timeline.mockClear();
    animationMock.gsap.matchMedia.mockClear();
    animationMock.timeline.to.mockClear();
    animationMock.timeline.fromTo.mockClear();
    for (const mock of Object.values(managementMock)) mock.mockReset();
    configApiMock.checkEditorAvailability.mockReset();
    configApiMock.checkEditorAvailability.mockResolvedValue({
      available: true,
    });
    const startupAgents = [
      agent({
        agent_id: 'claude_code',
        display_name: 'Claude Code',
        enabled: true,
        lifecycle: 'ready',
        runtime_version: '2.1.220',
        acp_version: '0.63.0',
      }),
      agent({ agent_id: 'codex', display_name: 'Codex' }),
    ];
    managementMock.bar.mockResolvedValue(startupAgents);
    managementMock.refreshBar.mockResolvedValue(startupAgents);
    managementMock.registry.mockResolvedValue({
      snapshot_id: 'snapshot',
      fetched_at: '2026-08-04T00:00:00Z',
      fresh: true,
      refresh_error: null,
      installed: [],
      uninstalled: [],
    });
    managementMock.setEnabled.mockResolvedValue(undefined);
    managementMock.addAndInstall.mockResolvedValue({
      operation_id: 'operation-codex',
      agent_id: 'codex',
      kind: 'install',
      status: 'queued',
    });
    managementMock.preflight.mockResolvedValue({
      agent_id: 'claude_code',
      checked_at: '2026-08-04T00:00:00Z',
      items: [
        {
          id: 'runtime',
          label: 'Runtime',
          status: 'pass',
          detail: '',
          repairable: true,
        },
      ],
    });
  });

  it('renders the localized product promise and plain-text intro actions', () => {
    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={vi.fn().mockResolvedValue(undefined)}
        onFinish={vi.fn()}
      />
    );

    expect(screen.getByText('集成且全能的Agent开发平台')).toBeInTheDocument();
    expect(screen.getByText('Kimi Code')).toBeInTheDocument();

    const nextButton = screen.getByRole('button', { name: '下一步' });
    expect(nextButton).toHaveClass('onboarding-skip-button');
    expect(nextButton.querySelector('svg')).toBeNull();
    expect(
      screen.queryByTestId('liquid-glass-surface')
    ).not.toBeInTheDocument();
  });

  it('reuses the completed startup Agent snapshot without forcing a second probe', async () => {
    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={vi.fn().mockResolvedValue(undefined)}
        onFinish={vi.fn()}
      />
    );

    await waitFor(() => expect(managementMock.bar).toHaveBeenCalledTimes(1));
    expect(managementMock.refreshBar).not.toHaveBeenCalled();
  });

  it('selects and prioritizes only installed Agents on first entry', async () => {
    const user = userEvent.setup();
    managementMock.bar.mockResolvedValue([
      agent({
        agent_id: 'claude_code',
        display_name: 'Claude Code',
        enabled: true,
      }),
      agent({
        agent_id: 'codex',
        display_name: 'Codex',
        enabled: false,
        lifecycle: 'ready',
        runtime_version: '0.145.0',
        acp_version: '1.1.9',
      }),
      agent({
        agent_id: 'opencode',
        display_name: 'OpenCode',
        enabled: false,
        lifecycle: 'ready',
        runtime_version: '1.18.2',
        acp_version: '1.18.2',
      }),
      agent({ agent_id: 'pi', display_name: 'Pi', enabled: true }),
    ]);

    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={vi.fn().mockResolvedValue(undefined)}
        onFinish={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByRole('checkbox', { name: '启用 Codex' });

    const rows = screen.getAllByRole('listitem');
    expect(
      rows.map((row) =>
        within(row).getByRole('checkbox').getAttribute('aria-label')
      )
    ).toEqual(['启用 Codex', '启用 OpenCode', '启用 Claude Code', '启用 Pi']);
    expect(screen.getByRole('checkbox', { name: '启用 Codex' })).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: '启用 OpenCode' })
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: '启用 Claude Code' })
    ).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '启用 Pi' })).not.toBeChecked();
    expect(
      screen.getByRole('combobox', { name: '默认 Agent' })
    ).toHaveTextContent('Codex');
  });

  it('skips the entire first-run flow through the public persistence boundary', async () => {
    const user = userEvent.setup();
    const onPersist = vi.fn().mockResolvedValue(undefined);
    const onFinish = vi.fn();
    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={onPersist}
        onFinish={onFinish}
      />
    );

    await user.click(screen.getByRole('button', { name: '跳过设置' }));

    expect(onPersist).toHaveBeenCalledWith({
      editor,
      defaultAgentId: 'claude_code',
      skipped: true,
    });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('keeps the aurora background moving on the configuration step', async () => {
    const user = userEvent.setup();
    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={vi.fn().mockResolvedValue(undefined)}
        onFinish={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '下一步' }));
    animationMock.gsap.to.mockClear();
    animationMock.callback?.();

    expect(animationMock.gsap.to).toHaveBeenCalledWith(
      '.onboarding-aurora',
      expect.objectContaining({ repeat: -1, yoyo: true })
    );
    expect(animationMock.gsap.to).toHaveBeenCalledWith(
      '.onboarding-aurora-layer-a',
      expect.objectContaining({ repeat: -1, yoyo: true })
    );
    expect(animationMock.gsap.to).toHaveBeenCalledWith(
      '.onboarding-aurora-layer-b',
      expect.objectContaining({ repeat: -1, yoyo: true })
    );
  });

  it('checks local Agents only once when the language binding refreshes', async () => {
    const user = userEvent.setup();
    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={vi.fn().mockResolvedValue(undefined)}
        onFinish={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByRole('checkbox', { name: '启用 Claude Code' });
    expect(managementMock.bar).toHaveBeenCalledTimes(1);

    await act(async () => {
      await i18n.changeLanguage('en');
    });

    expect(managementMock.bar).toHaveBeenCalledTimes(1);

    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
  });

  it('shows the local Agent check over a blurred list preview', async () => {
    const user = userEvent.setup();
    let resolveAgents: (agents: AgentManagementView[]) => void = () =>
      undefined;
    managementMock.bar.mockReturnValue(
      new Promise<AgentManagementView[]>((resolve) => {
        resolveAgents = resolve;
      })
    );

    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={vi.fn().mockResolvedValue(undefined)}
        onFinish={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '下一步' }));

    expect(
      screen.getByRole('status', { name: '正在进行本地Agent检查' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('agent-loading-preview')).toHaveClass(
      'onboarding-agent-loading-preview'
    );
    expect(
      screen.queryByText('正在检测本地 Runtime 与 ACP Registry…')
    ).not.toBeInTheDocument();

    await act(async () => {
      resolveAgents([
        agent({ agent_id: 'claude_code', display_name: 'Claude Code' }),
      ]);
    });
    await screen.findByRole('checkbox', { name: '启用 Claude Code' });
  });

  it('enforces enabled/default selection and starts installation before welcome', async () => {
    const user = userEvent.setup();
    const onPersist = vi.fn().mockResolvedValue(undefined);
    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={onPersist}
        onFinish={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '下一步' }));
    expect(
      screen.queryByRole('heading', { name: '先把工作台调成你的习惯' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        '已发现的本地 Runtime 优先显示；内置 Agent 排在其他 ACP Agent 之前。'
      )
    ).not.toBeInTheDocument();

    await screen.findByRole('checkbox', { name: '启用 Claude Code' });
    await user.click(screen.getByRole('checkbox', { name: '启用 Codex' }));
    expect(screen.getByRole('checkbox', { name: '启用 Codex' })).toBeChecked();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);

    const defaultAgentPicker = screen.getByRole('combobox', {
      name: '默认 Agent',
    });
    await user.click(defaultAgentPicker);
    const codexOption = screen.getByRole('option', { name: 'Codex' });
    expect(
      codexOption.querySelector('.onboarding-default-agent-icon')
    ).toBeInTheDocument();
    await user.click(codexOption);
    expect(
      defaultAgentPicker.querySelector('.onboarding-default-agent-icon')
    ).toBeInTheDocument();

    const editorPicker = screen.getByRole('combobox', {
      name: '外部编辑器',
    });
    expect(editorPicker).toHaveClass('onboarding-editor-select');
    await user.click(editorPicker);
    const editorList = screen.getByRole('listbox');
    expect(editorList).toHaveClass(
      'onboarding-popover-layer',
      'onboarding-editor-options'
    );
    expect(
      document.querySelector<HTMLElement>('.onboarding-experience')
    ).toContainElement(editorList);
    expect(screen.getByRole('option', { name: /Cursor/ })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /Cursor/ }));
    expect(screen.queryByText(/命令：/)).not.toBeInTheDocument();
    expect(
      screen.queryByText('从下拉中选择编辑器，列表会标注其可用状态。')
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '开始安装并继续' }));

    await waitFor(() => {
      expect(managementMock.setEnabled).toHaveBeenCalledWith('codex', true);
      expect(managementMock.addAndInstall).toHaveBeenCalledWith('codex');
      expect(onPersist).toHaveBeenCalledWith({
        editor: { ...editor, editor_type: EditorType.CURSOR },
        defaultAgentId: 'codex',
        skipped: false,
      });
    });
    expect(
      screen.getByRole('heading', { name: '欢迎来到 VibeX' })
    ).toBeInTheDocument();
  });

  it('enters welcome without waiting for the background install receipt', async () => {
    const user = userEvent.setup();
    let resolveInstall!: (value: {
      operation_id: string;
      agent_id: string;
      kind: 'install';
      status: 'queued';
    }) => void;
    managementMock.addAndInstall.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve;
        })
    );

    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={vi.fn().mockResolvedValue(undefined)}
        onFinish={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByRole('checkbox', { name: '启用 Codex' });
    await user.click(screen.getByRole('checkbox', { name: '启用 Codex' }));
    await user.click(screen.getByRole('combobox', { name: '默认 Agent' }));
    await user.click(screen.getByRole('option', { name: 'Codex' }));
    await user.click(screen.getByRole('button', { name: '开始安装并继续' }));

    expect(managementMock.addAndInstall).toHaveBeenCalledWith('codex');
    expect(
      await screen.findByRole(
        'heading',
        { name: '欢迎来到 VibeX' },
        { timeout: 250 }
      )
    ).toBeInTheDocument();

    resolveInstall({
      operation_id: 'operation-codex',
      agent_id: 'codex',
      kind: 'install',
      status: 'queued',
    });
  });

  it('prioritizes recommended Agents and explains why the default picker cannot open yet', async () => {
    const user = userEvent.setup();
    managementMock.bar.mockResolvedValue([
      agent({ agent_id: 'pi', display_name: 'Pi' }),
      agent({ agent_id: 'opencode', display_name: 'OpenCode' }),
      agent({ agent_id: 'codex', display_name: 'Codex' }),
      agent({ agent_id: 'claude_code', display_name: 'Claude Code' }),
      agent({
        agent_id: 'agora',
        display_name: 'Agoragentic',
        built_in: false,
        source: 'official_registry',
      }),
    ]);

    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={vi.fn().mockResolvedValue(undefined)}
        onFinish={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByRole('checkbox', { name: '启用 Claude Code' });

    expect(
      screen.getByRole('heading', { name: '选择出战的 Agent' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '选择外部编辑器' })
    ).toBeInTheDocument();

    const rows = screen.getAllByRole('listitem');
    ['Claude Code', 'Codex', 'OpenCode', 'Pi'].forEach((name, index) => {
      expect(
        within(rows[index]).getByRole('checkbox', { name: `启用 ${name}` })
      ).toBeInTheDocument();
      expect(within(rows[index]).getByText('推荐')).toBeInTheDocument();
    });

    const defaultAgentPicker = screen.getByRole('combobox', {
      name: '默认 Agent',
    });
    await user.click(defaultAgentPicker);
    expect(
      screen.getByText('请先在上方选择希望启用的Agent')
    ).toBeInTheDocument();
    expect(defaultAgentPicker).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByRole('checkbox', { name: '启用 Codex' }));
    expect(
      screen.queryByText('请先在上方选择希望启用的Agent')
    ).not.toBeInTheDocument();
    await user.click(defaultAgentPicker);
    expect(screen.getByRole('option', { name: 'Codex' })).toBeInTheDocument();
  });

  it('shows a red prompt under the default picker when starting without a default Agent', async () => {
    const user = userEvent.setup();
    const onPersist = vi.fn().mockResolvedValue(undefined);
    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={onPersist}
        onFinish={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '下一步' }));
    const claudeToggle = await screen.findByRole('checkbox', {
      name: '启用 Claude Code',
    });
    // 取消默认 Agent 后默认选择被清空；再启用 Codex → 有启用但无默认
    await user.click(claudeToggle);
    await user.click(screen.getByRole('checkbox', { name: '启用 Codex' }));

    const startButton = screen.getByRole('button', {
      name: '开始安装并继续',
    });
    expect(startButton).toBeEnabled();
    await user.click(startButton);

    const prompt = screen.getByText('请选择一个默认 Agent');
    expect(prompt).toHaveClass('onboarding-default-agent-prompt');
    expect(prompt).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('combobox', { name: '默认 Agent' })).toHaveClass(
      'has-error'
    );
    expect(managementMock.setEnabled).not.toHaveBeenCalled();
    expect(managementMock.addAndInstall).not.toHaveBeenCalled();
    expect(onPersist).not.toHaveBeenCalled();

    // 选择默认 Agent 后红色提示消失，流程可继续
    await user.click(screen.getByRole('combobox', { name: '默认 Agent' }));
    await user.click(screen.getByRole('option', { name: 'Codex' }));
    expect(screen.queryByText('请选择一个默认 Agent')).not.toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: '默认 Agent' })
    ).not.toHaveClass('has-error');
  });

  it('prompts to enable Agents first when starting without any enabled Agent', async () => {
    const user = userEvent.setup();
    managementMock.bar.mockResolvedValue([
      agent({
        agent_id: 'claude_code',
        display_name: 'Claude Code',
      }),
      agent({ agent_id: 'codex', display_name: 'Codex' }),
    ]);
    const onPersist = vi.fn().mockResolvedValue(undefined);
    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={onPersist}
        onFinish={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByRole('checkbox', { name: '启用 Claude Code' });

    const startButton = screen.getByRole('button', {
      name: '开始安装并继续',
    });
    expect(startButton).toBeEnabled();
    await user.click(startButton);

    const prompt = screen.getByText('请先在上方选择希望启用的Agent');
    expect(prompt).toHaveClass('onboarding-default-agent-prompt');
    expect(managementMock.setEnabled).not.toHaveBeenCalled();
    expect(managementMock.addAndInstall).not.toHaveBeenCalled();
    expect(onPersist).not.toHaveBeenCalled();

    // 启用一个 Agent 后提示消失
    await user.click(screen.getByRole('checkbox', { name: '启用 Codex' }));
    expect(
      screen.queryByText('请先在上方选择希望启用的Agent')
    ).not.toBeInTheDocument();
  });

  it('refreshes a stale registry snapshot before installing Agents', async () => {
    const user = userEvent.setup();
    managementMock.registry.mockResolvedValue({
      snapshot_id: 'stale',
      fetched_at: '2026-07-01T00:00:00Z',
      fresh: false,
      refresh_error: null,
      installed: [],
      uninstalled: [],
    });
    managementMock.refreshRegistry.mockResolvedValue({
      snapshot_id: 'snapshot',
      fetched_at: '2026-08-04T00:00:00Z',
      fresh: true,
      refresh_error: null,
      installed: [],
      uninstalled: [],
    });

    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={vi.fn().mockResolvedValue(undefined)}
        onFinish={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByRole('checkbox', { name: '启用 Codex' });
    await user.click(screen.getByRole('checkbox', { name: '启用 Codex' }));
    await user.click(screen.getByRole('combobox', { name: '默认 Agent' }));
    await user.click(screen.getByRole('option', { name: 'Codex' }));
    await user.click(screen.getByRole('button', { name: '开始安装并继续' }));

    await waitFor(() => {
      expect(managementMock.refreshRegistry).toHaveBeenCalled();
      expect(managementMock.addAndInstall).toHaveBeenCalledWith('codex');
    });
  });

  it('continues installation when the registry snapshot check fails', async () => {
    const user = userEvent.setup();
    managementMock.registry.mockRejectedValue(new Error('offline'));

    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={vi.fn().mockResolvedValue(undefined)}
        onFinish={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByRole('checkbox', { name: '启用 Codex' });
    await user.click(screen.getByRole('checkbox', { name: '启用 Codex' }));
    await user.click(screen.getByRole('combobox', { name: '默认 Agent' }));
    await user.click(screen.getByRole('option', { name: 'Codex' }));
    await user.click(screen.getByRole('button', { name: '开始安装并继续' }));

    await waitFor(() => {
      expect(managementMock.addAndInstall).toHaveBeenCalledWith('codex');
    });
  });

  it('keeps the start button disabled while the editor command is invalid', async () => {
    const user = userEvent.setup();
    render(
      <FirstRunExperience
        open
        initialEditor={{
          editor_type: EditorType.CUSTOM,
          custom_command: '',
          remote_ssh_host: null,
          remote_ssh_user: null,
        }}
        initialDefaultAgentId="claude_code"
        onPersist={vi.fn().mockResolvedValue(undefined)}
        onFinish={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByRole('checkbox', { name: '启用 Claude Code' });
    expect(
      screen.getByRole('button', { name: '开始安装并继续' })
    ).toBeDisabled();
  });
});
