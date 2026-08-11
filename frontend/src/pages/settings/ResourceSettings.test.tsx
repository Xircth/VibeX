import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
});
