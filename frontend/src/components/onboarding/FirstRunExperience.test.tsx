import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorType, type AgentManagementView } from 'shared/types';

import i18n from '@/i18n';

import { FirstRunExperience } from './FirstRunExperience';

const managementMock = vi.hoisted(() => ({
  bar: vi.fn(),
  discoveryProgress: vi.fn(),
  refreshBar: vi.fn(),
  registry: vi.fn(),
  refreshRegistry: vi.fn(),
  setEnabled: vi.fn(),
  addAndInstall: vi.fn(),
  preflight: vi.fn(),
}));

const transportMock = vi.hoisted(() => ({
  listeners: new Map<string, (payload: unknown) => void>(),
}));

const configApiMock = vi.hoisted(() => ({
  checkEditorAvailability: vi.fn(),
}));

const versionControlApiMock = vi.hoisted(() => ({
  detectGit: vi.fn(),
  installTools: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
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

vi.mock('@/features/agent-management', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/agent-management')>()),
  agentManagementApi: managementMock,
}));

vi.mock('@/lib/api', () => ({
  configApi: configApiMock,
  settingsWindowApi: { open: vi.fn() },
  versionControlApi: versionControlApiMock,
}));

vi.mock('@/lib/backendTransport', () => ({
  backendListen: vi.fn(
    async (event: string, handler: (payload: unknown) => void) => {
      transportMock.listeners.set(event, handler);
      return () => transportMock.listeners.delete(event);
    }
  ),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: toastMock,
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
    for (const mock of Object.values(toastMock)) mock.mockReset();
    transportMock.listeners.clear();
    configApiMock.checkEditorAvailability.mockReset();
    configApiMock.checkEditorAvailability.mockResolvedValue({
      available: true,
    });
    versionControlApiMock.detectGit.mockReset();
    versionControlApiMock.installTools.mockReset();
    versionControlApiMock.detectGit.mockResolvedValue({
      installed: true,
      version: '2.47.0',
      path: '/usr/bin/git',
      message: null,
    });
    versionControlApiMock.installTools.mockResolvedValue({
      git: {
        installed: true,
        version: '2.47.0',
        path: '/usr/bin/git',
        message: null,
      },
      github: {
        gh_installed: true,
        gh_path: '/usr/bin/gh',
        authenticated: false,
        username: null,
        host: 'github.com',
        message: null,
      },
      identity_configured: true,
      error: null,
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
    managementMock.discoveryProgress.mockResolvedValue({
      phase: 'complete',
      completed: 12,
      total: 12,
      found: 1,
      checked_agent_ids: ['claude_code', 'codex'],
      timed_out: false,
    });
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
          version: null,
          path: null,
          source: null,
          repairable: true,
          update_available: false,
          available_version: null,
          update_group: null,
        },
      ],
    });
  });

  it('renders the product-site hero copy, equation, and primary next action', async () => {
    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={vi.fn().mockResolvedValue(undefined)}
        onFinish={vi.fn()}
      />
    );

    await waitFor(() => expect(managementMock.registry).toHaveBeenCalled());

    expect(
      screen.getByRole('heading', { name: 'Agent 需要新的 IDE 于是有了 VibeX' })
    ).toBeInTheDocument();
    expect(
      screen.getByText('All in One 的综合 VibeCoding 强大平台')
    ).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-eq-line')).toHaveTextContent('VibeX');
    expect(screen.getByTestId('onboarding-eq-line')).toHaveTextContent(
      'Cursor'
    );
    expect(screen.getByTestId('onboarding-hero-scatter')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-hero-glow')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-product-stack')).toBeInTheDocument();
    expect(
      screen.getByTestId('onboarding-product-stack').querySelectorAll('img')
    ).toHaveLength(5);

    const nextButton = screen.getByRole('button', { name: '下一步' });
    expect(nextButton).toHaveClass('onboarding-primary-button');
    expect(nextButton.querySelector('svg')).toBeNull();
    expect(screen.getByRole('button', { name: '跳过设置' })).toHaveClass(
      'onboarding-skip-button'
    );
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

  it('completes the initial Agent catalog load under React StrictMode', async () => {
    const user = userEvent.setup();
    let resolveAgents: ((agents: AgentManagementView[]) => void) | undefined;
    managementMock.bar.mockReturnValue(
      new Promise<AgentManagementView[]>((resolve) => {
        resolveAgents = resolve;
      })
    );

    render(
      <StrictMode>
        <FirstRunExperience
          open
          initialEditor={editor}
          initialDefaultAgentId="claude_code"
          onPersist={vi.fn().mockResolvedValue(undefined)}
          onFinish={vi.fn()}
        />
      </StrictMode>
    );

    await waitFor(() => expect(managementMock.bar).toHaveBeenCalledTimes(1));
    act(() => {
      resolveAgents?.([
        agent({
          agent_id: 'claude_code',
          display_name: 'Claude Code',
          local_runtime: {
            path: '/usr/local/bin/claude',
            version: '2.1.220',
          },
        }),
      ]);
    });

    await user.click(screen.getByRole('button', { name: '下一步' }));

    expect(
      await screen.findByRole('checkbox', { name: '启用 Claude Code' })
    ).toBeInTheDocument();
    expect(screen.queryByText('正在加载 Agent 列表')).not.toBeInTheDocument();
  });

  it('does not restart the initial catalog request on startup invalidations', async () => {
    const user = userEvent.setup();
    let resolveAgents: ((agents: AgentManagementView[]) => void) | undefined;
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

    await waitFor(() =>
      expect(
        transportMock.listeners.has('agent-management-snapshot-invalidated')
      ).toBe(true)
    );
    await user.click(screen.getByRole('button', { name: '下一步' }));
    expect(
      screen.getByRole('status', { name: '正在加载 Agent 列表' })
    ).toBeInTheDocument();
    act(() => {
      transportMock.listeners.get('agent-management-snapshot-invalidated')?.(
        undefined
      );
      transportMock.listeners.get('agent-management-snapshot-invalidated')?.(
        undefined
      );
    });

    expect(managementMock.bar).toHaveBeenCalledTimes(1);

    act(() => {
      resolveAgents?.([
        agent({
          agent_id: 'claude_code',
          display_name: 'Claude Code',
          local_runtime: {
            path: '/usr/local/bin/claude',
            version: '2.1.220',
          },
        }),
      ]);
    });

    expect(
      await screen.findByRole('checkbox', { name: '启用 Claude Code' })
    ).toBeInTheDocument();
    expect(screen.queryByText('正在加载 Agent 列表')).not.toBeInTheDocument();
  });

  it('selects and prioritizes only locally detected Agents on first entry', async () => {
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
        local_runtime: {
          path: 'C:\\Users\\developer\\AppData\\Roaming\\npm\\codex.cmd',
          version: 'codex-cli 0.145.0',
        },
      }),
      agent({
        agent_id: 'opencode',
        display_name: 'OpenCode',
        enabled: false,
        local_runtime: {
          path: '/home/developer/.local/bin/opencode',
          version: '1.18.2',
        },
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

  it('keeps the product-site hero background on the configuration step', async () => {
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

    expect(screen.getByTestId('onboarding-hero-glow')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '选择出战的 Agent' })
    ).toBeInTheDocument();
    expect(document.querySelector('.onboarding-aurora')).toBeNull();
  });

  it('keeps the disclaimer off the intro step', async () => {
    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={vi.fn().mockResolvedValue(undefined)}
        onFinish={vi.fn()}
      />
    );

    expect(
      screen.queryByRole('button', { name: '免责声明' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '免责声明' })).toBeNull();
  });

  it('places an underlined disclaimer at the bottom of the configuration step', async () => {
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

    const footer = document.querySelector('.onboarding-config-footer');
    expect(footer).not.toBeNull();
    const link = within(footer as HTMLElement).getByRole('button', {
      name: '免责声明',
    });
    expect(link).toHaveClass('onboarding-disclaimer-link');
    expect(link).toHaveTextContent('免责声明');
    expect(footer).toHaveTextContent('继续即表示你已阅读并同意');
  });

  it('opens the full product risk disclaimer from the configuration footer', async () => {
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
    await user.click(screen.getByRole('button', { name: '免责声明' }));

    const dialog = screen.getByRole('dialog', { name: '免责声明' });
    expect(dialog).toBeInTheDocument();
    expect(
      within(dialog).getByRole('heading', { name: '免责声明' })
    ).toBeInTheDocument();

    const requiredSections = [
      '软件性质与无担保',
      'Agent 与本机执行',
      '第三方 Agent、安装与凭据',
      '插件与扩展',
      'Git、工作区与破坏性操作',
      '自动化、工作流与无人值守运行',
      '多智能体委派',
      '远程访问、配对与隧道',
      '聊天通道与外部指令',
      '数据、模型服务与隐私',
      '预览、脚本与终端',
      '费用、合规与第三方条款',
      '责任限制',
    ];
    for (const title of requiredSections) {
      expect(
        within(dialog).getByRole('heading', { name: title })
      ).toBeInTheDocument();
    }

    expect(dialog).toHaveTextContent('操作系统级沙箱');
    expect(dialog).toHaveTextContent('全信任');
    expect(dialog).toHaveTextContent('强制推送');
    expect(dialog).toHaveTextContent('工作站设备');
    expect(dialog).toHaveTextContent('明文');
    expect(dialog).toHaveTextContent('第三方模型');

    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog', { name: '免责声明' })).toBeNull();
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

  it('uses a catalog loading state before the Agent list is available', async () => {
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
      screen.getByRole('status', { name: '正在加载 Agent 列表' })
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

  it('keeps the Agent catalog loading while local detection is still running', async () => {
    const user = userEvent.setup();
    managementMock.discoveryProgress.mockResolvedValue({
      phase: 'checking',
      completed: 3,
      total: 12,
      found: 1,
      checked_agent_ids: ['claude_code', 'codex', 'antigravity'],
      timed_out: false,
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

    expect(
      await screen.findByRole('status', { name: '正在检查本地 Agent' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('agent-loading-preview')).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: '启用 Claude Code' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('未安装')).not.toBeInTheDocument();
    const progress = await screen.findByRole('progressbar', {
      name: '本地 Agent 检查进度',
    });
    expect(progress).toHaveAttribute('aria-valuenow', '3');
    expect(progress).toHaveAttribute('aria-valuemax', '12');
    expect(screen.getByText('已检查 3 / 12')).toBeInTheDocument();
    expect(screen.getByText('已发现 1 个可用 Agent')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '外部编辑器' })).toBeEnabled();
  });

  it('updates local check progress from backend events without showing an uninstalled list', async () => {
    const user = userEvent.setup();
    managementMock.discoveryProgress.mockResolvedValue({
      phase: 'checking',
      completed: 1,
      total: 12,
      found: 0,
      checked_agent_ids: ['claude_code'],
      timed_out: false,
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
    await screen.findByText('已检查 1 / 12');
    await waitFor(() =>
      expect(
        transportMock.listeners.has('agent-management-discovery-progress')
      ).toBe(true)
    );

    act(() => {
      transportMock.listeners.get('agent-management-discovery-progress')?.({
        phase: 'checking',
        completed: 8,
        total: 12,
        found: 2,
        checked_agent_ids: ['claude_code', 'codex'],
        timed_out: false,
      });
    });

    expect(screen.getByText('已检查 8 / 12')).toBeInTheDocument();
    expect(
      screen.getByRole('status', { name: '正在检查本地 Agent' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: '启用 Claude Code' })
    ).not.toBeInTheDocument();
  });

  it('merges discovered Agents without overwriting the user selection', async () => {
    const user = userEvent.setup();
    managementMock.bar.mockResolvedValueOnce([
      agent({ agent_id: 'claude_code', display_name: 'Claude Code' }),
      agent({ agent_id: 'codex', display_name: 'Codex' }),
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
    const codex = await screen.findByRole('checkbox', { name: '启用 Codex' });
    await user.click(codex);

    managementMock.bar.mockResolvedValue([
      agent({
        agent_id: 'claude_code',
        display_name: 'Claude Code',
        local_runtime: {
          path: '/usr/local/bin/claude',
          version: '2.1.220',
        },
      }),
      agent({ agent_id: 'codex', display_name: 'Codex' }),
    ]);
    await waitFor(() =>
      expect(
        transportMock.listeners.has('agent-management-snapshot-invalidated')
      ).toBe(true)
    );

    act(() => {
      transportMock.listeners.get('agent-management-snapshot-invalidated')?.(
        undefined
      );
    });

    await waitFor(() => expect(managementMock.bar).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole('checkbox', { name: '启用 Claude Code' })
    ).toBeChecked();
    expect(codex).toBeChecked();
  });

  it('shows locally detected Agents without waiting for a stale Registry refresh', async () => {
    const user = userEvent.setup();
    managementMock.registry.mockResolvedValue({
      snapshot_id: 'stale-snapshot',
      fetched_at: '2026-08-01T00:00:00Z',
      fresh: false,
      refresh_error: null,
      installed: [],
      uninstalled: [],
    });
    managementMock.refreshRegistry.mockReturnValue(new Promise(() => {}));

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
      await screen.findByRole(
        'checkbox',
        { name: '启用 Claude Code' },
        { timeout: 250 }
      )
    ).toBeInTheDocument();
    expect(managementMock.refreshRegistry).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('status', { name: '正在进行本地Agent检查' })
    ).not.toBeInTheDocument();
  });

  it('shows locally detected Agents without waiting for the Registry snapshot', async () => {
    const user = userEvent.setup();
    managementMock.registry.mockReturnValue(new Promise(() => {}));

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
      await screen.findByRole(
        'checkbox',
        { name: '启用 Claude Code' },
        { timeout: 250 }
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: '正在进行本地Agent检查' })
    ).not.toBeInTheDocument();
  });

  it('offers retry instead of loading the Agent catalog forever', async () => {
    vi.useFakeTimers();
    managementMock.bar.mockReturnValue(new Promise(() => {}));

    try {
      render(
        <FirstRunExperience
          open
          initialEditor={editor}
          initialDefaultAgentId="claude_code"
          onPersist={vi.fn().mockResolvedValue(undefined)}
          onFinish={vi.fn()}
        />
      );

      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.click(screen.getByRole('button', { name: '下一步' }));
      expect(
        screen.getByRole('status', { name: '正在加载 Agent 列表' })
      ).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });

      expect(screen.getByRole('alert')).toHaveTextContent(
        'Agent 列表加载超时，请重试'
      );
      expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a recoverable error instead of a completed empty Agent list', async () => {
    const user = userEvent.setup();
    managementMock.bar.mockResolvedValue([]);

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

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '未能加载 Agent 列表，请重试'
    );
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
    expect(
      screen.queryByRole('combobox', { name: '默认 Agent' })
    ).not.toBeInTheDocument();
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
    const editorList = await screen.findByRole('listbox');
    expect(editorList).toHaveClass(
      'onboarding-popover-layer',
      'onboarding-editor-options'
    );
    expect(editorList).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Cursor/ })).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
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

  it('shows the message from a structured Agent installation error', async () => {
    const user = userEvent.setup();
    managementMock.addAndInstall.mockRejectedValue({
      code: 'internal',
      message: '未找到兼容的系统 Node.js',
      agent_id: 'codex',
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

    await waitFor(
      () => {
        expect(toastMock.error).toHaveBeenCalledWith(
          'Codex Agent 安装失败，请在设置中查看',
          expect.objectContaining({
            details: [
              expect.objectContaining({
                description: '未找到兼容的系统 Node.js',
              }),
            ],
          })
        );
      },
      { timeout: 2_500 }
    );
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

  it('skips version control setup when Git is already installed', async () => {
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

    await waitFor(() =>
      expect(versionControlApiMock.detectGit).toHaveBeenCalled()
    );
    await user.click(screen.getByRole('button', { name: '下一步' }));

    expect(
      screen.getByRole('heading', { name: '选择出战的 Agent' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '版本管理器配置' })
    ).not.toBeInTheDocument();
  });

  it('asks for a Git identity on the setup page when Git is missing', async () => {
    const user = userEvent.setup();
    const onPersist = vi.fn().mockResolvedValue(undefined);
    versionControlApiMock.detectGit.mockResolvedValue({
      installed: false,
      version: null,
      path: null,
      message: 'Git not detected',
    });
    render(
      <FirstRunExperience
        open
        initialEditor={editor}
        initialDefaultAgentId="claude_code"
        onPersist={onPersist}
        onFinish={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(versionControlApiMock.detectGit).toHaveBeenCalled()
    );
    await user.click(screen.getByRole('button', { name: '下一步' }));

    expect(
      await screen.findByRole('heading', { name: '选择出战的 Agent' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '版本管理器配置' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始安装并继续' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请填写名称和邮箱');
    expect(versionControlApiMock.installTools).not.toHaveBeenCalled();
    expect(onPersist).not.toHaveBeenCalled();

    await user.type(screen.getByPlaceholderText('例如：张三'), 'Ada');
    await user.type(
      screen.getByPlaceholderText('name@example.com'),
      'ada@example.com'
    );
    await user.click(screen.getByRole('button', { name: '开始安装并继续' }));

    await waitFor(() =>
      expect(versionControlApiMock.installTools).toHaveBeenCalledWith({
        user_name: 'Ada',
        user_email: 'ada@example.com',
      })
    );
    expect(onPersist).toHaveBeenCalled();
    expect(
      await screen.findByRole('heading', { name: /欢迎来到/ })
    ).toBeInTheDocument();
  });

  it('keeps the setup page open and retries after a failed Git install', async () => {
    const user = userEvent.setup();
    versionControlApiMock.detectGit.mockResolvedValue({
      installed: false,
      version: null,
      path: null,
      message: 'Git not detected',
    });
    versionControlApiMock.installTools
      .mockResolvedValueOnce({
        git: {
          installed: false,
          version: null,
          path: null,
          message: 'timeout',
        },
        github: {
          gh_installed: false,
          gh_path: null,
          authenticated: false,
          username: null,
          host: 'github.com',
          message: null,
        },
        identity_configured: false,
        error: '官方源超时',
      })
      .mockResolvedValueOnce({
        git: {
          installed: true,
          version: '2.47.0',
          path: '/usr/bin/git',
          message: null,
        },
        github: {
          gh_installed: true,
          gh_path: '/usr/bin/gh',
          authenticated: false,
          username: null,
          host: 'github.com',
          message: null,
        },
        identity_configured: true,
        error: null,
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

    await waitFor(() =>
      expect(versionControlApiMock.detectGit).toHaveBeenCalled()
    );
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByRole('heading', { name: '版本管理器配置' });
    await user.type(screen.getByPlaceholderText('例如：张三'), 'Ada');
    await user.type(
      screen.getByPlaceholderText('name@example.com'),
      'ada@example.com'
    );
    await user.click(screen.getByRole('button', { name: '开始安装并继续' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('官方源超时');
    expect(
      screen.getByRole('heading', { name: '选择出战的 Agent' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '版本管理器配置' })
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重试安装' }));
    await waitFor(() =>
      expect(versionControlApiMock.installTools).toHaveBeenCalledTimes(2)
    );
    expect(
      await screen.findByRole('heading', { name: /欢迎来到/ })
    ).toBeInTheDocument();
  });
});
