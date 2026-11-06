import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  StatusBarConnectorButton,
  dispatchOpenConnectorMarketplace,
} from '@/components/connectors/ConnectorMarketplace';
import { InstructionsSettings } from './InstructionsSettings';
import { McpSettings } from './McpSettings';
import { SkillsSettings } from './SkillsSettings';

const mocks = vi.hoisted(() => ({
  agentOptions: [{ value: 'codex', label: 'Codex' }],
  listLocalInstructions: vi.fn(),
  listOfficialInstructions: vi.fn(),
  createInstruction: vi.fn(),
  updateInstruction: vi.fn(),
  deleteInstruction: vi.fn(),
  installOfficialInstruction: vi.fn(),
  scanMcp: vi.fn(),
  listMcpMarketplaces: vi.fn(),
  searchMcp: vi.fn(),
  detailMcp: vi.fn(),
  installMcp: vi.fn(),
  upsertMcp: vi.fn(),
  uninstallMcp: vi.fn(),
  scanSkills: vi.fn(),
  readSkill: vi.fn(),
  searchSkills: vi.fn(),
  detailSkill: vi.fn(),
  installSkill: vi.fn(),
  setSkillHosting: vi.fn(),
  uninstallSkill: vi.fn(),
  pluginCatalog: vi.fn(),
  configurePluginAgents: vi.fn(),
  configurePluginMcp: vi.fn(),
}));

vi.mock('@/features/agent-management', () => ({
  useManagedAgentOptions: () => mocks.agentOptions,
}));

vi.mock('@/lib/api', () => ({
  instructionsApi: {
    listLocal: mocks.listLocalInstructions,
    listOfficial: mocks.listOfficialInstructions,
    create: mocks.createInstruction,
    update: mocks.updateInstruction,
    delete: mocks.deleteInstruction,
    installOfficial: mocks.installOfficialInstruction,
  },
  mcpMarketApi: {
    scanLocal: mocks.scanMcp,
    listMarketplaces: mocks.listMcpMarketplaces,
    search: mocks.searchMcp,
    detail: mocks.detailMcp,
    install: mocks.installMcp,
    upsertLocal: mocks.upsertMcp,
    uninstall: mocks.uninstallMcp,
  },
  skillsMarketApi: {
    scanLocal: mocks.scanSkills,
    readLocal: mocks.readSkill,
    search: mocks.searchSkills,
    detail: mocks.detailSkill,
    install: mocks.installSkill,
    setHosting: mocks.setSkillHosting,
    uninstall: mocks.uninstallSkill,
  },
}));

vi.mock('@/lib/api/plugins', () => ({
  pluginControlApi: {
    catalog: mocks.pluginCatalog,
    configureAgents: mocks.configurePluginAgents,
    configureMcp: mocks.configurePluginMcp,
  },
}));

const savedInstruction = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'review_changes',
  content: 'Review the current changes.',
  agent_types: ['codex'],
  source: 'local',
  description: null,
  created_at: '2026-08-03T00:00:00Z',
  updated_at: '2026-08-03T00:00:00Z',
};

function renderSettings(
  settings: ReactElement,
  initialEntries = ['/settings']
) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <HotkeysProvider initiallyActiveScopes={['dialog', 'kanban', 'projects']}>
        {settings}
      </HotkeysProvider>
    </MemoryRouter>
  );
}

describe('InstructionsSettings', () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) {
      if (typeof value === 'function' && 'mockReset' in value)
        value.mockReset();
    }
    mocks.listLocalInstructions.mockResolvedValue([]);
    mocks.listOfficialInstructions.mockResolvedValue([]);
  });

  it('creates a local instruction with an explicit Agent target', async () => {
    const user = userEvent.setup();
    mocks.createInstruction.mockResolvedValue(savedInstruction);
    mocks.listLocalInstructions
      .mockResolvedValueOnce([])
      .mockResolvedValue([savedInstruction]);
    const { container } = renderSettings(<InstructionsSettings />);

    await user.click(await screen.findByRole('button', { name: '新建指令' }));
    await user.type(
      screen.getByPlaceholderText('review_changes'),
      'review_changes'
    );
    await user.type(
      container.querySelector('textarea')!,
      'Review the current changes.'
    );
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mocks.createInstruction).toHaveBeenCalledWith({
        name: 'review_changes',
        content: 'Review the current changes.',
        agent_types: ['codex'],
      });
    });
  });

  it('configures an official instruction into the local collection', async () => {
    const user = userEvent.setup();
    const official = {
      ...savedInstruction,
      id: 'official-review',
      name: 'official_review',
      source: 'official',
      description: 'Official review prompt',
    };
    mocks.listOfficialInstructions.mockResolvedValue([official]);
    mocks.createInstruction.mockResolvedValue(savedInstruction);
    renderSettings(<InstructionsSettings />);

    await user.click(await screen.findByRole('button', { name: '官方市场' }));
    await user.click(
      await screen.findByRole('button', { name: /official_review/ })
    );
    await user.click(screen.getByRole('button', { name: '配置到本地' }));

    await waitFor(() => {
      expect(mocks.createInstruction).toHaveBeenCalledWith({
        name: 'official_review',
        content: 'Review the current changes.',
        agent_types: ['codex'],
      });
    });
  });
});

describe('McpSettings', () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) {
      if (typeof value === 'function' && 'mockReset' in value)
        value.mockReset();
    }
    mocks.scanMcp.mockResolvedValue([]);
    mocks.listMcpMarketplaces.mockResolvedValue([
      { id: 'smithery', name: 'Smithery', description: 'MCP marketplace' },
    ]);
    mocks.searchMcp.mockResolvedValue([]);
  });

  it('creates a valid local MCP server and records its global target', async () => {
    const user = userEvent.setup();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const created = {
      id: 'filesystem',
      spec: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'your-mcp-server'],
      },
      global: true,
      apps: [],
    };
    mocks.upsertMcp.mockResolvedValue([created]);
    renderSettings(<McpSettings />);

    await user.click(screen.getByRole('radio', { name: '本地 MCP' }));
    await user.click(await screen.findByRole('button', { name: '新建 MCP' }));
    await user.type(
      screen.getByPlaceholderText('例如 filesystem'),
      'filesystem'
    );
    await user.click(screen.getByRole('button', { name: '新建' }));

    await waitFor(() => {
      expect(mocks.upsertMcp).toHaveBeenCalledWith({
        serverId: 'filesystem',
        spec: created.spec,
        global: true,
        apps: [],
      });
    });

    const renderedWarnings = consoleError.mock.calls.flat().join(' ');
    consoleError.mockRestore();
    expect(renderedWarnings).not.toContain(
      'changing an uncontrolled input to be controlled'
    );
  });

  it('configures a plugin built-in MCP for selected Agents', async () => {
    const user = userEvent.setup();
    mocks.agentOptions = [
      { value: 'codex', label: 'Codex' },
      { value: 'claude_code', label: 'Claude Code' },
    ];
    mocks.pluginCatalog.mockResolvedValue({
      plugins: [
        {
          id: 'dev.vibex.research',
          name: 'Research Toolkit',
          skills: [{ id: 'research', path: 'skills/research/SKILL.md' }],
        },
      ],
      runtimes: [],
    });
    mocks.configurePluginMcp.mockResolvedValue({ mcpErrors: [] });
    renderSettings(<McpSettings />, [
      '/settings/mcp?plugin=dev.vibex.research',
    ]);

    expect(
      await screen.findByText('配置 Research Toolkit 的 MCP 目标')
    ).toBeVisible();
    await user.click(await screen.findByLabelText('Codex'));
    await user.click(screen.getByRole('button', { name: '保存 MCP 目标' }));

    await waitFor(() => {
      expect(mocks.configurePluginMcp).toHaveBeenCalledWith(
        'dev.vibex.research',
        false,
        ['codex']
      );
    });
  });

  it('renders Connectors header, SegmentedControl, local MCP list items, and full-width ConnectorMarketplace', async () => {
    const user = userEvent.setup();
    mocks.scanMcp.mockResolvedValue([
      {
        id: 'node_repl',
        spec: {
          type: 'stdio',
          command: 'C:\\Users\\18190\\AppData\\Local\\OpenAI\\Codex\\node.exe',
        },
        global: false,
        apps: ['codex'],
      },
    ]);
    mocks.searchMcp.mockResolvedValue([
      {
        provider_id: 'smithery',
        server_id: '@smithery/github',
        name: 'GitHub MCP',
        description: 'GitHub integration',
        icon_url: null,
        verified: true,
        remote: true,
        protocols: ['http'],
        downloads: 120,
        homepage: null,
      },
    ]);

    renderSettings(<McpSettings />);

    expect(
      await screen.findByRole('heading', { name: '连接器' })
    ).toBeVisible();

    const localTabRadio = screen.getByRole('radio', { name: '本地 MCP' });
    const marketTabRadio = screen.getByRole('radio', { name: 'MCP 市场' });
    expect(localTabRadio.querySelector('svg')).not.toBeNull();
    expect(marketTabRadio.querySelector('svg')).not.toBeNull();
    expect(marketTabRadio).toBeChecked();

    const searchInput = await screen.findByPlaceholderText('搜索应用');
    expect(searchInput).toBeVisible();
    const marketContainer = searchInput.closest('.dsh-connector-marketplace');
    expect(marketContainer?.parentElement).not.toHaveClass(
      'rounded-xl',
      'border',
      'bg-card'
    );
    expect(
      screen.getByRole('button', { name: 'MCP 服务器' })
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '开发者工具' })).toBeVisible();
    expect(screen.getByRole('button', { name: '分析' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'model context protocol' })
    ).toBeVisible();

    const marketItem = await screen.findByRole('button', {
      name: /GitHub MCP/,
    });
    expect(marketItem).toHaveClass('!my-0', '!h-auto', '!min-h-0');

    // Verify Composio and Aiwyn Tax MCP are not hardcoded as 'included' (show Connect button instead)
    expect(
      screen.getByRole('button', { name: '连接 Composio' })
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: '连接 Aiwyn Tax MCP' })
    ).toBeVisible();
    expect(screen.queryByText('已包含')).not.toBeInTheDocument();

    // Verify root container has min-h-0 flex-1 overflow-hidden w-full and browse-all button works
    expect(marketContainer).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-hidden',
      'w-full'
    );
    const browseAllBtn = screen.getByRole('button', {
      name: /浏览全部连接器/,
    });
    expect(browseAllBtn).toBeVisible();
    await user.click(browseAllBtn);
    // In ungrouped browse-all view, items beyond the first 4 of developer_tools (e.g. Sentry, Vercel) are visible
    expect(screen.getByRole('button', { name: '连接 Sentry' })).toBeVisible();
    expect(screen.getByRole('button', { name: '连接 Vercel' })).toBeVisible();

    await user.click(localTabRadio);

    const localItem = await screen.findByRole('button', { name: /node_repl/ });
    expect(localItem).toHaveClass('!my-0', '!h-auto', '!min-h-0');
  });

  it('opens the centered ConnectorMarketplace dialog from StatusBarConnectorButton and supports custom MCP creation', async () => {
    const user = userEvent.setup();
    mocks.scanMcp.mockResolvedValue([]);
    mocks.searchMcp.mockResolvedValue([]);
    mocks.upsertMcp.mockResolvedValue([
      {
        id: 'custom-mcp',
        spec: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/path'],
        },
        global: true,
        apps: [],
      },
    ]);

    renderSettings(<StatusBarConnectorButton />);

    const triggerBtn = screen.getByRole('button', { name: '连接器市场' });
    expect(triggerBtn).toHaveClass('h-4', 'w-4', 'opacity-80');
    const storeSvg = triggerBtn.querySelector('svg');
    expect(storeSvg).toHaveClass('h-3', 'w-3');
    expect(storeSvg).toHaveAttribute('stroke-width', '1.6');

    await user.click(triggerBtn);

    expect(
      await screen.findByText(
        '只需连接一次应用或你自己的 MCP 服务器，再选择哪些机器人可以使用。'
      )
    ).toBeVisible();
    expect(screen.getAllByRole('button', { name: '关闭' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'MCP 服务器' }));
    await user.type(
      await screen.findByPlaceholderText('例如 filesystem'),
      'custom-mcp'
    );
    await user.click(screen.getByRole('button', { name: '新建' }));

    await waitFor(() => {
      expect(mocks.upsertMcp).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: 'custom-mcp',
          global: true,
          apps: [],
        })
      );
    });

    dispatchOpenConnectorMarketplace({ searchQuery: 'Supabase' });
    expect(await screen.findByDisplayValue('Supabase')).toBeVisible();
  });

  it('parses URL, CLI command, and mcpServers JSON for custom MCP server input', async () => {
    const { parseCustomMcpInput } = await import(
      '@/components/connectors/ConnectorMarketplace'
    );

    // 1. Remote HTTP & SSE URLs
    expect(parseCustomMcpInput('https://mcp.linear.app/mcp')).toEqual({
      serverId: 'linear',
      spec: {
        type: 'http',
        url: 'https://mcp.linear.app/mcp',
      },
    });
    expect(parseCustomMcpInput('https://mcp.asana.com/sse')).toEqual({
      serverId: 'asana',
      spec: {
        type: 'sse',
        url: 'https://mcp.asana.com/sse',
      },
    });

    // 2. Direct CLI command (npx) & `claude mcp add` command
    expect(
      parseCustomMcpInput(
        'npx -y @modelcontextprotocol/server-postgres postgresql://localhost/mydb'
      )
    ).toEqual({
      serverId: 'postgres',
      spec: {
        type: 'stdio',
        command: 'npx',
        args: [
          '-y',
          '@modelcontextprotocol/server-postgres',
          'postgresql://localhost/mydb',
        ],
      },
    });

    expect(
      parseCustomMcpInput(
        'claude mcp add --transport stdio -e API_KEY=secret twitter-mcp -- npx -y @enescinar/twitter-mcp'
      )
    ).toEqual({
      serverId: 'twitter-mcp',
      spec: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@enescinar/twitter-mcp'],
        env: { API_KEY: 'secret' },
      },
    });

    // 3. Full `mcpServers` and VS Code `servers` JSON config blocks
    expect(
      parseCustomMcpInput(
        JSON.stringify({
          mcpServers: {
            'my-custom-server': {
              command: 'uvx',
              args: ['mcp-server-git'],
            },
          },
        })
      )
    ).toEqual({
      serverId: 'my-custom-server',
      spec: {
        type: 'stdio',
        command: 'uvx',
        args: ['mcp-server-git'],
      },
    });

    expect(
      parseCustomMcpInput(
        JSON.stringify({
          servers: {
            'vscode-server': {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-memory'],
            },
          },
        })
      )
    ).toEqual({
      serverId: 'vscode-server',
      spec: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
      },
    });
  });
});

describe('SkillsSettings', () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) {
      if (typeof value === 'function' && 'mockReset' in value)
        value.mockReset();
    }
    mocks.searchSkills.mockResolvedValue([]);
    mocks.scanSkills.mockResolvedValue([]);
    mocks.agentOptions = [{ value: 'codex', label: 'Codex' }];
  });

  it('assigns every skill from an enabled plugin to selected Agents', async () => {
    const user = userEvent.setup();
    mocks.agentOptions = [
      { value: 'codex', label: 'Codex' },
      { value: 'claude_code', label: 'Claude Code' },
    ];
    const pluginSkills = ['office-pptx', 'office-docx', 'office-xlsx'];
    mocks.pluginCatalog.mockResolvedValue({
      plugins: [
        {
          id: 'vibex.office',
          name: 'Office',
          skills: pluginSkills.map((id) => ({
            id,
            path: `skills/${id}/SKILL.md`,
          })),
        },
      ],
      runtimes: [],
    });
    mocks.scanSkills.mockResolvedValue(
      pluginSkills.map((id) => ({
        id,
        name: id,
        description: null,
        group: 'office',
        global: false,
        apps: ['codex'],
        path: `/tmp/${id}/SKILL.md`,
      }))
    );
    mocks.configurePluginAgents.mockResolvedValue([]);

    renderSettings(<SkillsSettings />, [
      '/settings/skills?plugin=vibex.office',
    ]);

    expect(
      await screen.findByRole('heading', { name: '配置 Office Skill' })
    ).toBeVisible();
    expect(await screen.findByText('分配 Agent')).toBeVisible();
    expect(await screen.findByLabelText('Codex')).toBeChecked();
    expect(await screen.findByLabelText('Claude Code')).not.toBeChecked();
    await user.click(screen.getByLabelText('Claude Code'));
    await user.click(screen.getByRole('button', { name: '保存 Agent 分配' }));

    await waitFor(() => {
      expect(mocks.configurePluginAgents).toHaveBeenCalledWith(
        'vibex.office',
        false,
        ['codex', 'claude_code']
      );
    });
  });

  it('reads, retargets, and uninstalls a locally hosted skill', async () => {
    const user = userEvent.setup();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const skill = {
      id: 'review-code',
      name: 'Review code',
      description: 'Review a patch',
      group: 'review',
      global: true,
      apps: [],
      path: '/tmp/review-code/SKILL.md',
    };
    mocks.scanSkills.mockResolvedValue([skill]);
    mocks.readSkill.mockResolvedValue({
      id: skill.id,
      path: skill.path,
      content: '# Review code',
    });
    mocks.setSkillHosting.mockResolvedValue([skill]);
    mocks.uninstallSkill.mockResolvedValue([]);
    renderSettings(<SkillsSettings />);

    await user.click(screen.getByRole('radio', { name: '本地 Skill' }));
    await user.click(
      await screen.findByRole('button', { name: /review-code/ })
    );
    expect(await screen.findByText('# Review code')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '应用（复制）' }));
    await waitFor(() => {
      expect(mocks.setSkillHosting).toHaveBeenCalledWith({
        skillId: 'review-code',
        global: true,
        apps: [],
        link: false,
      });
    });

    await user.click(screen.getByRole('button', { name: '卸载' }));
    await waitFor(() => {
      expect(mocks.uninstallSkill).toHaveBeenCalledWith('review-code');
    });

    const renderedWarnings = consoleError.mock.calls.flat().join(' ');
    consoleError.mockRestore();
    expect(renderedWarnings).not.toContain(
      'changing an uncontrolled input to be controlled'
    );
  });

  it('renders the full-width Skills Leaderboard and opens the two-column SKILL.md detail view with inline installation', async () => {
    const user = userEvent.setup();
    mocks.searchSkills.mockResolvedValue([
      {
        id: 'vercel-labs/skills/find-skills',
        skill_id: 'find-skills',
        name: 'find-skills',
        installs: 749500,
        source: 'vercel-labs/skills',
        weekly_installs: [120, 180, 240, 310, 420, 510, 630, 750],
        is_official: true,
      },
    ]);
    mocks.detailSkill.mockResolvedValue({
      description: 'Fallback description',
      content: '---\nname: find-skills\n---\n# Find Skills Guide\n\nDiscover and install skills easily.',
    });
    mocks.installSkill.mockResolvedValue([
      {
        id: 'find-skills',
        name: 'find-skills',
        description: 'Discover and install skills easily.',
        group: 'find',
        global: true,
        apps: [],
        path: '/tmp/find-skills/SKILL.md',
      },
    ]);
    mocks.readSkill.mockResolvedValue({
      id: 'find-skills',
      path: '/tmp/find-skills/SKILL.md',
      content: '# Find Skills Guide',
    });

    renderSettings(<SkillsSettings />);

    expect(
      screen.getByRole('heading', { name: 'Skill' })
    ).toBeVisible();
    expect(screen.getByRole('radio', { name: 'Skill 市场' })).toBeChecked();

    expect(
      await screen.findByPlaceholderText('Search skills...')
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'SKILLS LEADERBOARD' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('来源：skills.sh')).not.toBeInTheDocument();
    expect(screen.getByText('8W ACTIVITY')).toBeVisible();
    expect(screen.getByText('749.5K')).toBeVisible();
    expect(screen.getByText('/')).toBeVisible();

    const allTimeTab = screen.getByRole('tab', { name: /All Time/ });
    expect(allTimeTab).toHaveClass('!rounded-none');

    const trendingTab = screen.getByRole('tab', { name: 'Trending (24h)' });
    expect(trendingTab).toHaveClass('!rounded-none');
    await user.click(trendingTab);
    await waitFor(() => {
      expect(mocks.searchSkills).toHaveBeenCalledWith('', 'trending');
    });

    await user.click(screen.getByText('find-skills'));

    expect(
      await screen.findByRole('heading', { name: 'Find Skills Guide' })
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '返回列表' })).toBeVisible();
    expect(screen.queryByText('SKILL.md')).not.toBeInTheDocument();

    const sourceLink = screen.getByRole('link', { name: /vercel-labs\/skills/ });
    const installsBadge = screen.getByText(/749\.5K INSTALLS/);
    expect(sourceLink.parentElement).toBe(installsBadge.parentElement);
    expect(
      sourceLink.compareDocumentPosition(installsBadge) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    expect(
      screen.getByText('npx skills add vercel-labs/skills --skill find-skills')
    ).toBeVisible();

    // Short SKILL.md content does not overflow page height -> Show More is hidden
    expect(
      screen.queryByRole('button', { name: 'Show More' })
    ).not.toBeInTheDocument();

    // Return to list and open a skill with long SKILL.md content (>24 lines) -> Show More appears
    const longContent = [
      '---',
      'name: find-skills',
      '---',
      '# Find Skills Guide',
      ...Array.from({ length: 30 }, (_, idx) => `- Step ${idx + 1}: Detailed instruction line`),
    ].join('\n');
    mocks.detailSkill.mockResolvedValueOnce({
      description: 'Fallback description',
      content: longContent,
    });

    await user.click(screen.getByRole('button', { name: '返回列表' }));
    await user.click(await screen.findByText('find-skills'));

    const showMoreBtn = await screen.findByRole('button', { name: 'Show More' });
    expect(showMoreBtn).toBeVisible();
    await user.click(showMoreBtn);
    expect(screen.getByRole('button', { name: 'Show Less' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '安装' }));
    await waitFor(() => {
      expect(mocks.installSkill).toHaveBeenCalledWith({
        source: 'vercel-labs/skills',
        skillId: 'find-skills',
        global: true,
        apps: [],
        link: false,
      });
    });
  });
});


