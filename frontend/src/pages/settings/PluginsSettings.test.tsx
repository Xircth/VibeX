import { open } from '@tauri-apps/plugin-dialog';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import type { PluginControlCatalog } from '@/lib/api/plugins';
import { PluginsSettings } from './PluginsSettings';

const catalog: PluginControlCatalog = {
  plugins: [
    {
      id: 'vibex.office',
      name: 'VibeX Office',
      version: '2.0.0',
      description: 'Create and edit office artifacts.',
      enabled: true,
      builtin: true,
      shellTrusted: false,
      sourceKind: 'builtin',
      sourcePath: '/Applications/VibeX/assets/plugins/office',
      formats: ['vibex'],
      skills: [
        { id: 'office-pptx', path: 'skills/office-pptx/SKILL.md' },
        { id: 'office-docx', path: 'skills/office-docx/SKILL.md' },
        { id: 'office-xlsx', path: 'skills/office-xlsx/SKILL.md' },
      ],
      runtimes: [
        {
          id: 'officecli',
          command: 'officecli',
          version: '1.0.140',
          installer: 'existing',
        },
      ],
      warnings: [],
      mcpCount: 0,
      invocationCount: 6,
    },
    {
      id: 'dev.vibex.research',
      name: 'Research Toolkit',
      version: '1.4.0',
      description: 'Shared research workflow.',
      enabled: false,
      builtin: false,
      shellTrusted: false,
      sourceKind: 'developer_link',
      sourcePath: '/Users/me/plugins/research',
      formats: ['vibex', 'codex', 'claude_code'],
      skills: [
        { id: 'research', path: 'skills/research/SKILL.md' },
        { id: 'citations', path: 'skills/citations/SKILL.md' },
      ],
      runtimes: [
        {
          id: 'research-cli',
          command: 'research',
          version: '1.4.0',
          installer: 'shell',
          installCommand: './install.sh',
        },
      ],
      warnings: [],
      mcpCount: 1,
      mcpServers: ['research-mcp'],
      invocationCount: 2,
      invocations: [
        {
          id: 'research.run',
          label: '开始研究',
          prompt: 'Run the research workflow.',
          kind: 'action',
        },
        {
          id: 'research.citations',
          label: '整理引用',
          prompt: 'Format the collected citations.',
          kind: 'command',
        },
      ],
    },
    {
      id: 'openai.browser',
      name: 'Browser Tools',
      version: '1.0.0',
      description: 'Codex browser workflows.',
      enabled: true,
      builtin: false,
      shellTrusted: false,
      sourceKind: 'codex_native',
      sourcePath: '/Users/me/.codex/plugins/cache/browser',
      formats: ['codex'],
      skills: [{ id: 'browser', path: 'skills/browser/SKILL.md' }],
      runtimes: [],
      warnings: [],
      mcpCount: 0,
      invocationCount: 0,
      nativeManaged: true,
      enableSupported: false,
      updateSupported: false,
      uninstallSupported: true,
    },
    {
      id: 'anthropic.frontend',
      name: 'Frontend Design',
      version: '1.0.0',
      description: 'Claude Code frontend workflows.',
      enabled: true,
      builtin: false,
      shellTrusted: false,
      sourceKind: 'claude_code_native',
      sourcePath: '/Users/me/.claude/plugins/cache/frontend-design',
      formats: ['claude_code'],
      skills: [{ id: 'frontend-design', path: 'skills/frontend/SKILL.md' }],
      runtimes: [],
      warnings: [],
      mcpCount: 0,
      invocationCount: 0,
      nativeManaged: true,
      enableSupported: true,
      updateSupported: true,
      uninstallSupported: true,
    },
  ],
  runtimes: [],
};

const contributionDetails = {
  skills: [
    {
      id: 'research',
      path: 'skills/research/SKILL.md',
      content: '# Research workflow\n\nInvestigate primary sources.',
    },
    {
      id: 'citations',
      path: 'skills/citations/SKILL.md',
      content: '# Citation workflow\n\nAttach precise source links.',
    },
  ],
  mcpServers: [
    {
      id: 'research-mcp',
      config: {
        command: 'research-mcp',
        args: ['serve'],
      },
    },
  ],
};

function LocationProbe() {
  const location = useLocation();
  return (
    <output aria-label="Current location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function transport(overrides: Record<string, unknown> = {}) {
  const call = vi.fn(async (command: string, args?: unknown) => {
    if (command in overrides) {
      const value = overrides[command];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown)(args)
        : value;
    }
    if (command === 'plugin_control_catalog') return catalog;
    if (command === 'plugin_control_contributions') {
      return contributionDetails;
    }
    if (command === 'plugin_control_set_enabled') return catalog.plugins[1];
    if (command === 'plugin_control_update') return catalog.plugins[3];
    if (command === 'plugin_control_configure_agents') return [];
    throw new Error(`unexpected command: ${command}`);
  });
  const stream = vi.fn(
    async (
      command: string,
      args: Record<string, unknown>,
      onMessage: (message: unknown) => void
    ) => {
      if (command !== 'plugin_control_import_cli') {
        throw new Error(`unexpected stream command: ${command}`);
      }
      onMessage({ event: 'started', command: args.command });
      onMessage({
        event: 'log',
        stream: 'stdout',
        line: 'Installed frontend-design@official',
      });
      onMessage({ event: 'command_finished', success: true, exitCode: 0 });
      return {
        success: true,
        importedPluginIds: ['frontend-design@official'],
      };
    }
  );
  return {
    call,
    stream,
    value: { environment: 'desktop', call, stream } as BackendTransport,
  };
}

function renderSettings(backend: BackendTransport, showLocation = false) {
  return render(
    <MemoryRouter initialEntries={['/settings/plugins']}>
      <PluginsSettings transport={backend} />
      {showLocation ? <LocationProbe /> : null}
    </MemoryRouter>
  );
}

describe('PluginsSettings', () => {
  beforeEach(() => {
    vi.mocked(open).mockReset();
    localStorage.clear();
  });

  it('separates native ecosystems into tabs and searches only the active tab', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value);

    expect(await screen.findByRole('heading', { name: '插件' })).toBeVisible();
    expect(
      screen.getByText('在此管理 Codex、ClaudeCode 以及 VibeX 平台支持的插件')
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: '插件控制面' })
    ).not.toBeInTheDocument();

    const tabs = await screen.findByRole('tablist', { name: '插件生态' });
    const headerActions = tabs.closest('.plugin-hub-header-actions');
    expect(headerActions).not.toBeNull();
    expect(headerActions).toContainElement(
      screen.getByRole('button', { name: '导入插件' })
    );
    const codexTab = within(tabs).getByRole('tab', { name: 'Codex' });
    expect(codexTab).toHaveAttribute('aria-selected', 'true');
    expect(within(codexTab).getByTitle('Codex')).toBeInTheDocument();
    expect(
      within(within(tabs).getByRole('tab', { name: 'Claude Code' })).getByTitle(
        'Claude Code'
      )
    ).toBeInTheDocument();
    expect(screen.getAllByText('Browser Tools').length).toBeGreaterThan(0);
    const browserRow = screen.getByRole('button', { name: /Browser Tools/ });
    expect(within(browserRow).queryByText('Codex')).not.toBeInTheDocument();
    expect(screen.queryByText('VibeX Office')).not.toBeInTheDocument();
    expect(screen.queryByText('Frontend Design')).not.toBeInTheDocument();

    await user.type(
      screen.getByRole('searchbox', { name: '搜索 Codex 插件' }),
      'office'
    );
    expect(screen.queryByText('Browser Tools')).not.toBeInTheDocument();
    expect(screen.queryByText('VibeX Office')).not.toBeInTheDocument();

    await user.click(within(tabs).getByRole('tab', { name: 'VibeX' }));
    expect((await screen.findAllByText('VibeX Office')).length).toBeGreaterThan(
      0
    );
    expect(screen.getByText('Research Toolkit')).toBeVisible();
    const officeRow = screen.getByRole('button', { name: /VibeX Office/ });
    expect(within(officeRow).queryByText('VibeX')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Research Toolkit/ }));
    const detail = screen.getByRole('region', { name: 'Research Toolkit' });
    const detailHeader = detail.querySelector('.plugin-detail-header');
    expect(detailHeader).not.toBeNull();
    expect(
      within(detailHeader as HTMLElement).getByText('VibeX')
    ).toBeVisible();
    expect(
      within(detailHeader as HTMLElement).getByText('Codex')
    ).toBeVisible();
    expect(
      within(detailHeader as HTMLElement).getByText('Claude Code')
    ).toBeVisible();
    expect(within(detail).getByText('VibeX')).toBeVisible();
    expect(within(detail).getByText('Codex')).toBeVisible();
    expect(within(detail).getByText('Claude Code')).toBeVisible();
    expect(within(detail).getByText('2 个技能')).toBeVisible();
    expect(within(detail).getByText('1 个 MCP')).toBeVisible();
    expect(within(detail).getByText('./install.sh')).toBeVisible();
    expect(within(detail).getByRole('heading', { name: '来源' })).toBeVisible();

    await user.click(within(tabs).getByRole('tab', { name: 'Claude Code' }));
    expect(screen.getAllByText('Frontend Design').length).toBeGreaterThan(0);
    expect(screen.queryByText('Research Toolkit')).not.toBeInTheDocument();
  });

  it('resizes the catalog and preview panes by dragging or using the keyboard', async () => {
    const backend = transport();
    renderSettings(backend.value);

    const separator = await screen.findByRole('separator', {
      name: '调整插件列表宽度',
    });
    const grid = separator.closest('.plugin-hub-grid');
    expect(grid).not.toBeNull();
    vi.spyOn(grid as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 1100,
      top: 0,
      bottom: 600,
      width: 1000,
      height: 600,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(separator, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(separator, 'releasePointerCapture', {
      configurable: true,
      value: vi.fn(),
    });

    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 410 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 540 });
    fireEvent.pointerUp(separator, { pointerId: 1 });

    expect(separator).toHaveAttribute('aria-valuenow', '44');
    expect(grid).toHaveStyle('--plugin-list-width: 44%');

    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(separator).toHaveAttribute('aria-valuenow', '42');
    expect(localStorage.getItem('vibex.pluginHub.listPanePercent')).toBe('42');
  });

  it('orders the overview sections and shows MCP names without their configuration', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value);

    await user.click(await screen.findByRole('tab', { name: 'VibeX' }));
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );

    const detail = screen.getByRole('region', { name: 'Research Toolkit' });
    expect(within(detail).getByText('2 个调用命令')).toBeVisible();
    expect(within(detail).getByText('research-mcp')).toBeVisible();
    expect(
      within(detail).queryByText('research-mcp serve')
    ).not.toBeInTheDocument();
    expect(within(detail).getByText('开始研究')).toBeVisible();
    expect(within(detail).getByText('整理引用')).toBeVisible();
    expect(
      within(detail).queryByText('Run the research workflow.')
    ).not.toBeInTheDocument();

    const headings = within(detail)
      .getAllByRole('heading', { level: 4 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(['Skills', 'Runtime', 'MCP', '调用命令', '来源']);
  });

  it('enables through the unified command and offers all-agent or MCP settings', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value, true);
    await user.click(await screen.findByRole('tab', { name: 'VibeX' }));
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );

    await user.click(
      screen.getByRole('switch', { name: '启用 Research Toolkit' })
    );

    expect(backend.call).toHaveBeenCalledWith('plugin_control_set_enabled', {
      pluginId: 'dev.vibex.research',
      enabled: true,
    });
    expect(backend.call).toHaveBeenCalledWith(
      'plugin_control_configure_agents',
      {
        pluginId: 'dev.vibex.research',
        allAgents: true,
        agents: [],
      }
    );
    const dialog = await screen.findByRole('dialog', { name: '配置插件能力' });
    expect(within(dialog).getAllByText(/内置 MCP/).length).toBeGreaterThan(0);
    expect(
      within(dialog).getByRole('button', {
        name: '跳过并为全部 Agent 启用 MCP',
      })
    ).toBeVisible();

    await user.click(
      within(dialog).getByRole('button', { name: '前往 MCP 设置' })
    );
    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      '/settings/mcp?plugin=dev.vibex.research'
    );
  });

  it('uses official native lifecycle actions instead of a disabled switch', async () => {
    const user = userEvent.setup();
    const backend = transport({
      plugin_control_set_enabled: {
        ...catalog.plugins[3],
        enabled: false,
      },
      plugin_control_update: catalog.plugins[3],
    });
    renderSettings(backend.value);

    const codexDetail = await screen.findByRole('region', {
      name: 'Browser Tools',
    });
    expect(within(codexDetail).queryByRole('switch')).not.toBeInTheDocument();
    expect(
      within(codexDetail).queryByText('由原生管理器控制')
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Claude Code' }));
    const claudeDetail = await screen.findByRole('region', {
      name: 'Frontend Design',
    });
    expect(within(claudeDetail).queryByRole('switch')).not.toBeInTheDocument();

    await user.click(
      within(claudeDetail).getByRole('button', {
        name: '更新 Frontend Design',
      })
    );
    expect(backend.call).toHaveBeenCalledWith('plugin_control_update', {
      pluginId: 'anthropic.frontend',
    });

    await user.click(
      within(claudeDetail).getByRole('button', {
        name: '停用 Frontend Design',
      })
    );
    expect(backend.call).toHaveBeenCalledWith('plugin_control_set_enabled', {
      pluginId: 'anthropic.frontend',
      enabled: false,
    });
    expect(backend.call).not.toHaveBeenCalledWith(
      'plugin_control_configure_agents',
      expect.anything()
    );

    await user.click(
      within(claudeDetail).getByRole('button', { name: '卸载插件' })
    );
    expect(
      await screen.findByText(/调用对应 Agent 的官方命令卸载/)
    ).toBeVisible();
  });

  it('opens a Skill-only view and previews each SKILL.md on demand', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value);

    await user.click(await screen.findByRole('tab', { name: 'VibeX' }));
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );
    await user.click(screen.getByRole('button', { name: '2 个技能' }));

    expect(backend.call).toHaveBeenCalledWith('plugin_control_contributions', {
      pluginId: 'dev.vibex.research',
    });
    const skillView = await screen.findByRole('region', {
      name: 'Research Toolkit 技能',
    });
    expect(
      within(skillView).getByRole('heading', { name: 'Research workflow' })
    ).toBeVisible();

    await user.click(
      within(skillView).getByRole('button', { name: 'citations' })
    );
    expect(
      within(skillView).getByRole('heading', { name: 'Citation workflow' })
    ).toBeVisible();
    expect(within(skillView).queryByText('来源')).not.toBeInTheDocument();
    expect(within(skillView).queryByText('Runtime')).not.toBeInTheDocument();
  });

  it('opens an MCP-only view and renders each server configuration as JSON', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value);

    await user.click(await screen.findByRole('tab', { name: 'VibeX' }));
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );
    await user.click(screen.getByRole('button', { name: '1 个 MCP' }));

    const mcpView = await screen.findByRole('region', {
      name: 'Research Toolkit MCP',
    });
    expect(
      within(mcpView).getByRole('button', { name: 'research-mcp' })
    ).toBeVisible();
    expect(
      within(mcpView).getByText(/"command": "research-mcp"/)
    ).toBeVisible();
    expect(within(mcpView).getByText(/"args": \[/)).toBeVisible();
    expect(within(mcpView).queryByText('来源')).not.toBeInTheDocument();
    expect(within(mcpView).queryByText('Runtime')).not.toBeInTheDocument();
  });

  it('falls back to existing file IPC when the desktop backend has not restarted', async () => {
    const user = userEvent.setup();
    const backend = transport({
      plugin_control_contributions: () => {
        throw new Error('Command plugin_control_contributions not found');
      },
      read_file_content: (args: unknown) => {
        const { path } = args as { path: string };
        if (path.endsWith('skills/research/SKILL.md')) {
          return '# Research fallback\n\nLoaded through the file API.';
        }
        if (path.endsWith('skills/citations/SKILL.md')) {
          return '# Citations fallback';
        }
        if (path.endsWith('.vibex-plugin/plugin.json')) {
          return JSON.stringify({
            mcp: {
              mcpServers: {
                'research-mcp': {
                  command: 'research-mcp',
                  args: ['serve'],
                },
              },
            },
          });
        }
        throw new Error(`unexpected file: ${path}`);
      },
    });
    renderSettings(backend.value);

    await user.click(await screen.findByRole('tab', { name: 'VibeX' }));
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );
    await user.click(screen.getByRole('button', { name: '2 个技能' }));

    expect(
      await screen.findByRole('heading', { name: 'Research fallback' })
    ).toBeVisible();
    expect(backend.call).toHaveBeenCalledWith('read_file_content', {
      path: '/Users/me/plugins/research/skills/research/SKILL.md',
    });

    await user.click(screen.getByRole('button', { name: '1 个 MCP' }));
    const mcpView = await screen.findByRole('region', {
      name: 'Research Toolkit MCP',
    });
    expect(
      within(mcpView).getByText(/"command": "research-mcp"/)
    ).toBeVisible();
  });

  it('runs an official CLI import with visible logs and result', async () => {
    const user = userEvent.setup();
    const backend = transport();
    renderSettings(backend.value);

    await user.click(await screen.findByRole('button', { name: '导入插件' }));
    const dialog = await screen.findByRole('dialog', { name: '选择插件格式' });
    expect(within(dialog).queryByText('ChatGPT V1')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('ChatGPT V2')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Codex' })).toBeVisible();
    expect(
      within(dialog).getByRole('button', { name: /Claude Code/ })
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: /VibeX/ })).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Codex' }));
    expect(within(dialog).getByText('Skills-only ZIP')).toBeVisible();
    const command = within(dialog).getByRole('textbox', {
      name: 'Codex CLI 命令',
    });
    await user.type(
      command,
      'codex plugin marketplace add official\n' +
        'codex plugin add frontend-design@official'
    );
    await user.click(
      within(dialog).getByRole('button', { name: '运行并导入' })
    );

    expect(backend.stream).toHaveBeenCalledWith(
      'plugin_control_import_cli',
      {
        ecosystem: 'codex',
        command:
          'codex plugin marketplace add official\n' +
          'codex plugin add frontend-design@official',
      },
      expect.any(Function)
    );
    expect(await within(dialog).findByRole('log')).toHaveTextContent(
      'Installed frontend-design@official'
    );
    expect(within(dialog).getByText('导入完成')).toBeVisible();
    expect(within(dialog).getByText('frontend-design@official')).toBeVisible();

    await user.click(
      within(dialog).getByRole('button', { name: /Claude Code/ })
    );
    expect(
      within(dialog).getByRole('textbox', { name: 'Claude Code CLI 命令' })
    ).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: /^VibeX/ }));
    expect(within(dialog).getByText('VibeX 插件 ZIP')).toBeVisible();
    expect(within(dialog).queryByText(/CLI/)).not.toBeInTheDocument();
  });

  it('previews a VibeX ZIP and requires an explicit same-id replacement decision', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue('/Users/me/new-research.zip');
    const preview = {
      plugin: catalog.plugins[1],
      conflict: {
        pluginId: 'dev.vibex.research',
        installedSource: '/Users/me/plugins/research',
        incomingSource: '/Users/me/new-research',
      },
    };
    const backend = transport({
      plugin_control_preview_import: preview,
      plugin_control_import: catalog.plugins[1],
    });
    renderSettings(backend.value);

    await user.click(await screen.findByRole('button', { name: '导入插件' }));
    const chooser = await screen.findByRole('dialog', {
      name: '选择插件格式',
    });
    await user.click(within(chooser).getByRole('button', { name: /^VibeX/ }));
    await user.click(within(chooser).getByRole('button', { name: '选择 ZIP' }));
    const dialog = await screen.findByRole('dialog', {
      name: '导入 Research Toolkit',
    });
    expect(within(dialog).getByText(/相同插件 ID/)).toBeVisible();
    expect(
      within(dialog).getByText('/Users/me/plugins/research')
    ).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: '覆盖安装' }));
    expect(backend.call).toHaveBeenCalledWith('plugin_control_import', {
      path: '/Users/me/new-research.zip',
      developerLink: false,
      conflictDecision: 'replace',
      packageKind: 'vibex',
    });
  });

  it('shows the exact Runtime overwrite impact before installation', async () => {
    const user = userEvent.setup();
    const conflict = {
      runtimeId: 'research-cli',
      currentVersion: '1.3.0',
      targetVersion: '1.4.0',
      affectedPlugins: ['dev.vibex.legacy-research'],
      affectedAutomations: ['daily-research'],
    };
    const backend = transport({
      plugin_control_preview_runtime_install: conflict,
      plugin_control_install_runtime: {
        id: 'research-cli',
        version: '1.4.0',
        executablePath: '/Users/me/.local/bin/research',
      },
    });
    renderSettings(backend.value);
    await user.click(await screen.findByRole('tab', { name: 'VibeX' }));
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );

    await user.click(screen.getByRole('button', { name: '安装 research-cli' }));

    const dialog = await screen.findByRole('dialog', {
      name: '覆盖 Runtime research-cli？',
    });
    expect(within(dialog).getByText('1.3.0 → 1.4.0')).toBeVisible();
    expect(within(dialog).getByText('dev.vibex.legacy-research')).toBeVisible();
    expect(within(dialog).getByText('daily-research')).toBeVisible();

    await user.click(
      within(dialog).getByRole('button', { name: '确认覆盖并安装' })
    );
    expect(backend.call).toHaveBeenCalledWith(
      'plugin_control_install_runtime',
      {
        pluginId: 'dev.vibex.research',
        runtimeId: 'research-cli',
        confirmConflict: true,
      }
    );
  });

  it('shows source, command, and persistent plugin-ID risk before shell trust', async () => {
    const user = userEvent.setup();
    const backend = transport({ plugin_control_set_shell_trust: null });
    renderSettings(backend.value);
    await user.click(await screen.findByRole('tab', { name: 'VibeX' }));
    await user.click(
      await screen.findByRole('button', { name: /Research Toolkit/ })
    );

    await user.click(screen.getByRole('button', { name: '检查并信任' }));

    const dialog = await screen.findByRole('dialog', {
      name: '信任 Research Toolkit 的 Shell？',
    });
    expect(within(dialog).getByText('./install.sh')).toBeVisible();
    expect(
      within(dialog).getByText('/Users/me/plugins/research')
    ).toBeVisible();
    expect(within(dialog).getByText(/后续脚本内容变化/)).toBeVisible();

    await user.click(
      within(dialog).getByRole('button', { name: '信任此插件 ID' })
    );
    expect(backend.call).toHaveBeenCalledWith(
      'plugin_control_set_shell_trust',
      { pluginId: 'dev.vibex.research', trusted: true }
    );
  });
});
