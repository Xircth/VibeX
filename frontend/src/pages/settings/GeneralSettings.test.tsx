import { screen, waitFor } from '@testing-library/react';

import { renderWithQueryClient as render } from '@/test/QueryClientHarness';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorType, SoundFile, type Config } from 'shared/types';

import { GeneralSettings } from './GeneralSettings';

const configApiMock = vi.hoisted(() => ({
  checkEditorAvailability: vi.fn(),
  playNotificationSound: vi.fn(),
}));

const agentManagementApiMock = vi.hoisted(() => ({
  bar: vi.fn(),
}));

const agentsApiMock = vi.hoisted(() => ({
  refreshCapabilityCatalog: vi.fn(),
  capabilityCatalog: vi.fn(),
  capabilityCatalogFresh: vi.fn(),
}));

const userSystemMock = vi.hoisted(() => ({
  useUserSystem: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  configApi: configApiMock,
}));

vi.mock('@/features/agent-management/api', () => ({
  agentManagementApi: agentManagementApiMock,
}));

vi.mock('@/features/agents/api', () => ({
  agentsApi: agentsApiMock,
}));

vi.mock('@/features/agents/sessionControlsQuery', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/features/agents/sessionControlsQuery')
    >();
  return {
    ...actual,
    loadAgentSessionControlsCatalog: () => agentsApiMock.capabilityCatalog(),
  };
});

vi.mock('@/components/ConfigProvider', () => userSystemMock);

vi.mock('@/components/sessions/ImportLocalSessionsDialog', () => ({
  ImportLocalSessionsDialog: ({ open }: { open: boolean }) =>
    open ? <div>import-dialog</div> : null,
}));

vi.mock('@/features/history-import/useLocalHistoryImportJob', () => ({
  useLocalHistoryImportJob: () => ({
    status: 'idle',
    progress: null,
    result: null,
    log: [],
  }),
}));

vi.mock('@/lib/desktopShell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/desktopShell')>();
  return {
    ...actual,
    useLocalDesktopHost: () => true,
    isLocalDesktopHost: () => true,
  };
});

function promptEnhancementConfig(model: string): Config {
  return {
    editor: {
      editor_type: EditorType.VS_CODE,
      custom_command: null,
      remote_ssh_host: null,
      remote_ssh_user: null,
    },
    default_terminal_shell: null,
    notifications: {
      sound_enabled: true,
      push_enabled: true,
      sound_file: SoundFile.ABSTRACT_SOUND1,
      notify_when: 'unfocused',
    },
    prompt_enhancement_enabled: true,
    prompt_enhancement_model: model,
    prompt_enhancement_agent_id: '',
    prompt_enhancement_mode: null,
    prompt_enhancement_session_config: {},
    prompt_enhancement_prompt: null,
    compact_context_enabled: false,
    crash_reports_enabled: false,
  } as Config;
}

function renderSettings(
  model = 'opencode/minimax-m2.5-free',
  extra: Partial<Config> = {}
) {
  const updateAndSaveConfig = vi.fn().mockResolvedValue(true);
  userSystemMock.useUserSystem.mockReturnValue({
    config: { ...promptEnhancementConfig(model), ...extra },
    loading: false,
    updateAndSaveConfig,
  });
  return { ...render(<GeneralSettings />), updateAndSaveConfig };
}

describe('GeneralSettings basic guide', () => {
  beforeEach(() => {
    userSystemMock.useUserSystem.mockReturnValue({
      config: promptEnhancementConfig('opencode/minimax-m2.5-free'),
      loading: false,
      updateAndSaveConfig: vi.fn().mockResolvedValue(true),
    });
    configApiMock.checkEditorAvailability.mockResolvedValue({
      available: true,
    });
    agentManagementApiMock.bar.mockResolvedValue([]);
  });

  it('puts Restart basic guide at the bottom-right of General settings', () => {
    const { container } = render(<GeneralSettings />);
    const button = screen.getByRole('button', { name: '重新开始基础引导' });
    const content = container.querySelector('.settings-content');
    const sections = content?.querySelector('.settings-sections');
    expect(button).toBeInTheDocument();
    expect(sections).toBeTruthy();
    expect(
      Boolean(
        sections &&
          button.compareDocumentPosition(sections) &
            Node.DOCUMENT_POSITION_PRECEDING
      )
    ).toBe(true);
    expect(button.closest('.flex')?.className).toMatch(/justify-end/);
    expect(button.closest('.mt-auto')?.className).toMatch(/pt-12/);
    expect(content?.children[1]).toContainElement(button);
  });
});

describe('GeneralSettings Agent model catalogs', () => {
  beforeEach(() => {
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    for (const fn of Object.values(configApiMock)) {
      fn.mockReset();
    }
    agentManagementApiMock.bar.mockReset();
    agentsApiMock.refreshCapabilityCatalog.mockReset();
    agentsApiMock.capabilityCatalog.mockReset();
    agentsApiMock.capabilityCatalogFresh.mockReset();
    userSystemMock.useUserSystem.mockReset();
    configApiMock.checkEditorAvailability.mockResolvedValue({
      available: true,
    });
    configApiMock.playNotificationSound.mockResolvedValue(undefined);
    agentManagementApiMock.bar.mockResolvedValue([
      {
        agent_id: 'opencode',
        display_name: 'OpenCode',
        enabled: true,
        retired: false,
      },
    ]);
    agentsApiMock.capabilityCatalog.mockResolvedValue({
      modes: [],
      current_mode: null,
      config_options: [],
    });
    agentsApiMock.capabilityCatalogFresh.mockResolvedValue(true);
    agentsApiMock.refreshCapabilityCatalog.mockResolvedValue(true);
  });

  it('lists enabled Agents for prompt enhancement inside the modal', async () => {
    const user = userEvent.setup();
    renderSettings();

    await waitFor(() => {
      expect(agentManagementApiMock.bar).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByTestId('prompt-enhancement-edit-btn'));

    expect(
      await screen.findByRole('combobox', { name: '提示词优化Agent' })
    ).not.toBeDisabled();
  });

  it('refreshes the selected Agent session config on demand in the prompt enhancement modal', async () => {
    const user = userEvent.setup();
    renderSettings('unused', { prompt_enhancement_agent_id: 'opencode' });

    await user.click(screen.getByTestId('prompt-enhancement-edit-btn'));

    await waitFor(() => {
      expect(agentsApiMock.capabilityCatalog).toHaveBeenCalled();
    });

    await user.click(screen.getByRole('button', { name: '刷新会话配置' }));

    await waitFor(() => {
      expect(agentsApiMock.refreshCapabilityCatalog).toHaveBeenCalledWith(
        'opencode'
      );
    });
  });

  it('turns MultiAgent collaboration on immediately and renders default Agent roles in Custom Roles', async () => {
    const user = userEvent.setup();
    const { updateAndSaveConfig } = renderSettings(
      'opencode/minimax-m2.5-free',
      { multi_agent_enabled: false }
    );

    await user.click(await screen.findByRole('switch', { name: '协作空间' }));

    await waitFor(() => {
      expect(updateAndSaveConfig).toHaveBeenCalledWith({
        multi_agent_enabled: true,
      });
    });
    expect(screen.queryByText('暂不可用')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '角色' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('默认Agent委派配置')).not.toBeInTheDocument();
    expect(await screen.findByText('OpenCode · 默认配置')).toBeInTheDocument();
  });

  it('merges default Agent configs into Custom Roles with locked name/Agent and editable session config/persona', async () => {
    const user = userEvent.setup();
    agentsApiMock.capabilityCatalog.mockResolvedValue({
      modes: [{ id: 'code', label: 'Code' }],
      current_mode: 'code',
      config_options: [
        {
          key: 'model',
          label: 'Model',
          description: null,
          category: 'model',
          value: 'gpt-5',
          choices: [
            { value: 'gpt-5', label: 'GPT-5', description: null },
            { value: 'gpt-4o', label: 'GPT-4o', description: null },
          ],
        },
      ],
    });

    const { updateAndSaveConfig } = renderSettings(
      'opencode/minimax-m2.5-free',
      {
        multi_agent_enabled: true,
      }
    );

    expect(screen.queryByText('默认Agent委派配置')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('multi-agent-default-picker')
    ).not.toBeInTheDocument();

    expect(screen.getByText('自定义角色')).toBeInTheDocument();
    const headerCreateBtn = screen.getByTestId(
      'custom-roles-header-create-btn'
    );
    expect(headerCreateBtn).toBeInTheDocument();
    const rolesContainer = screen.getByTestId('custom-roles-list-container');
    expect(rolesContainer).toBeInTheDocument();

    const defaultRoleRow = await screen.findByTestId(
      'custom-role-row-default-agent:opencode'
    );
    expect(defaultRoleRow).toBeInTheDocument();
    expect(screen.getByText('OpenCode · 默认配置')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: '删除角色 OpenCode · 默认配置',
      })
    ).not.toBeInTheDocument();

    // Edit default Agent role: name and Agent are disabled, session config and persona are editable
    await user.click(
      screen.getByRole('button', { name: '编辑角色 OpenCode · 默认配置' })
    );
    const overlay = await screen.findByTestId('custom-role-modal-overlay');
    expect(overlay).toHaveClass('collaboration-settings-modal-overlay');
    expect(overlay).toHaveClass('inset-y-0', 'right-0');
    expect(overlay.style.left).toBe('12.5rem');
    expect(overlay.style.backdropFilter).toBe('blur(16px)');
    expect(
      await screen.findByRole('dialog', { name: '编辑角色' })
    ).toBeInTheDocument();

    const roleNameInput = screen.getByRole('textbox', { name: '角色名称' });
    expect(roleNameInput).toHaveValue('OpenCode · 默认配置');
    expect(roleNameInput).toBeDisabled();

    const roleAgentTrigger = screen.getByRole('combobox', {
      name: '选择角色 Agent',
    });
    expect(roleAgentTrigger).toBeDisabled();

    const sessionConfigSection = screen.getByTestId(
      'custom-role-session-config'
    );
    expect(sessionConfigSection).toBeInTheDocument();

    const personaInput = screen.getByRole('textbox', {
      name: '人设（可选）',
    });
    expect(personaInput).not.toBeDisabled();
    await user.type(personaInput, '专注于严谨架构审查');

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(updateAndSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          multi_agent_agent_defaults: {
            opencode: {
              mode_id: 'code',
              config_values: { model: 'gpt-5' },
            },
          },
        })
      );
    });
    expect(screen.getByText('专注于严谨架构审查')).toBeInTheDocument();

    expect(screen.queryByText('委派深度')).not.toBeInTheDocument();
    expect(screen.queryByText('完成缓存 (MB)')).not.toBeInTheDocument();
    expect(screen.queryByText('查询窗口（天）')).not.toBeInTheDocument();
    expect(screen.queryByText('延时上限（小时）')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '团队' })
    ).not.toBeInTheDocument();
  });

  it('persists a changed general preference through the shared config boundary', async () => {
    const user = userEvent.setup();
    const { updateAndSaveConfig } = renderSettings();

    await user.click(
      await screen.findByRole('switch', {
        name: '启动时提示未处理的崩溃报告',
      })
    );

    await waitFor(() => {
      expect(updateAndSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ crash_reports_enabled: true })
      );
    });
  });

  it('persists the detached window and sound notification preferences', async () => {
    const user = userEvent.setup();
    const { updateAndSaveConfig } = renderSettings();

    await user.click(await screen.findByRole('switch', { name: '声音通知' }));
    await user.click(
      screen.getByRole('switch', { name: '系统通知（桌面窗口）' })
    );

    await waitFor(() => {
      expect(updateAndSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          notifications: expect.objectContaining({
            sound_enabled: false,
            push_enabled: false,
          }),
        })
      );
    });
  });

  it('shows the notification timing control', async () => {
    renderSettings();

    expect(
      await screen.findByRole('combobox', { name: '提醒时机' })
    ).toHaveTextContent('仅当应用失焦时');
  });

  it('groups composer utilities, basics, and notifications', () => {
    renderSettings();

    expect(
      screen.getByRole('heading', { name: '实用功能' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '基础功能' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '会话功能' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '通知' })).toBeInTheDocument();

    expect(
      screen.getByRole('switch', { name: '提示词优化' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        '在会话输入框Composer中添加提示词优化按钮，建议选择Flash模型+Low强度'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: '手动压缩上下文' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        '在会话输入框Composer中添加手动压缩按钮，部分Agent可能无效'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('界面语言')).toBeInTheDocument();
    expect(screen.getByText('外部查看器')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Fork会话以创建' })
    ).toBeInTheDocument();
    expect(screen.getByText('本地会话导入')).toBeInTheDocument();
    expect(
      screen.getByText(
        '点击导入按钮以进行本地Agent会话数据导入，需先将对应项目导入VibeX，否则无法选择数据'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: '启动时提示未处理的崩溃报告' })
    ).toBeInTheDocument();
    expect(
      screen.getByText('在权限请求、提醒或对话完成时播放提示音。')
    ).toBeInTheDocument();
    expect(
      screen.getByText('在权限请求、提醒或对话完成时弹出系统桌面通知窗口。')
    ).toBeInTheDocument();

    expect(
      screen.queryByRole('heading', { name: '终端' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '外部编辑器' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '提示词优化' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '压缩上下文' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '会话创建' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '本地对话' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '崩溃报告' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '预览' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Markdown默认预览方式' })
    ).not.toBeInTheDocument();
  });

  it('opens a right-side blurred modal when enabling prompt enhancement and reverts the toggle if canceled', async () => {
    const user = userEvent.setup();
    renderSettings('unused', { prompt_enhancement_enabled: false });

    const peToggle = screen.getByRole('switch', { name: '提示词优化' });
    expect(peToggle).not.toBeChecked();
    expect(
      screen.queryByTestId('prompt-enhancement-list-container')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Agent' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('使用自定义优化提示词')).not.toBeInTheDocument();

    await user.click(peToggle);
    expect(peToggle).toBeChecked();

    const overlay = await screen.findByTestId(
      'prompt-enhancement-modal-overlay'
    );
    expect(overlay).toHaveClass('collaboration-settings-modal-overlay');
    expect(overlay.style.backdropFilter).toBe('blur(16px)');

    expect(
      screen.getByRole('combobox', { name: '提示词优化Agent' })
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('prompt-enhancement-session-config')
    ).toBeInTheDocument();
    const customPromptSwitch = screen.getByRole('switch', {
      name: '自定义优化提示词',
    });
    expect(customPromptSwitch).not.toBeChecked();
    expect(customPromptSwitch.parentElement).toHaveClass(
      'flex',
      'items-center',
      'justify-between'
    );
    expect(
      screen.queryByRole('textbox', { name: '自定义优化提示词' })
    ).not.toBeInTheDocument();

    // Turning on custom prompt switch reveals the editable prompt input
    await user.click(customPromptSwitch);
    const customPromptTextarea = screen.getByRole('textbox', {
      name: '自定义优化提示词',
    });
    expect(customPromptTextarea).toBeInTheDocument();
    expect(customPromptTextarea).not.toBeDisabled();

    // Clicking Cancel reverts the prompt enhancement switch to OFF and does not render the list
    await user.click(screen.getByTestId('prompt-enhancement-cancel-btn'));
    expect(
      screen.queryByTestId('prompt-enhancement-modal-overlay')
    ).not.toBeInTheDocument();
    expect(peToggle).not.toBeChecked();
    expect(
      screen.queryByTestId('prompt-enhancement-list-container')
    ).not.toBeInTheDocument();
  });

  it('keeps compact-context opt-in and persists it when enabled', async () => {
    const user = userEvent.setup();
    const { updateAndSaveConfig } = renderSettings();

    const toggle = await screen.findByRole('switch', {
      name: '手动压缩上下文',
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    await waitFor(() => {
      expect(updateAndSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ compact_context_enabled: true })
      );
    });
  });

  it('keeps previous-session continuation opt-in and persists it when enabled', async () => {
    const user = userEvent.setup();
    const { updateAndSaveConfig } = renderSettings();

    const toggle = await screen.findByRole('switch', {
      name: 'Fork会话以创建',
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    await waitFor(() => {
      expect(updateAndSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ previous_session_continuation_enabled: true })
      );
    });
  });

  it('opens local session import from general settings', async () => {
    const user = userEvent.setup();
    renderSettings();

    expect(screen.getByText('本地会话导入')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '导入' }));
    expect(screen.getByText('import-dialog')).toBeInTheDocument();
  });

  it('saves prompt enhancement config from the modal and renders the single-item list with edit action only', async () => {
    const user = userEvent.setup();
    agentsApiMock.capabilityCatalog.mockResolvedValue({
      modes: [],
      current_mode: null,
      config_options: [
        {
          key: 'model',
          label: 'Model',
          description: null,
          category: 'model',
          value: 'grok-4.6',
          choices: [
            { value: 'grok-4.6', label: 'Grok 4.6', description: null },
            { value: 'grok-4.5', label: 'Grok 4.5', description: null },
          ],
        },
      ],
    });
    const { updateAndSaveConfig } = renderSettings('unused', {
      prompt_enhancement_enabled: false,
      prompt_enhancement_agent_id: 'opencode',
    });

    await user.click(screen.getByRole('switch', { name: '提示词优化' }));

    await waitFor(() => {
      expect(agentsApiMock.capabilityCatalog).toHaveBeenCalled();
    });

    const saveBtn = await screen.findByTestId('prompt-enhancement-save-btn');
    await user.click(saveBtn);

    await waitFor(() => {
      expect(updateAndSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt_enhancement_enabled: true,
          prompt_enhancement_agent_id: 'opencode',
          prompt_enhancement_session_config: { model: 'grok-4.6' },
        })
      );
    });

    const listContainer = await screen.findByTestId(
      'prompt-enhancement-list-container'
    );
    expect(listContainer).toHaveClass(
      'min-w-0',
      'overflow-hidden',
      'rounded-lg',
      'border'
    );
    const row = screen.getByTestId('prompt-enhancement-config-row');
    expect(row).toHaveTextContent('OpenCode');
    expect(row).toHaveTextContent('grok-4.6');
    expect(row).toHaveTextContent('自定义提示词：未开启');
    expect(
      screen.getByTestId('prompt-enhancement-edit-btn')
    ).toBeInTheDocument();
  });

  it('toggles Hide Bot sessions in the Collaboration space section', async () => {
    localStorage.removeItem('vibex:hide-bot-sessions');
    const user = userEvent.setup();
    renderSettings();

    const toggle = await screen.findByRole('switch', {
      name: '隐藏Bot会话',
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    expect(toggle).toBeChecked();
    expect(localStorage.getItem('vibex:hide-bot-sessions')).toBe('true');
  });

  it('truncates long custom role persona prompts without overflowing the settings width or crushing the role name', async () => {
    const collaborationApi = await import(
      '@/features/collaboration/collaborationApi'
    );
    const spy = vi
      .spyOn(collaborationApi, 'collaborationCall')
      .mockResolvedValue({
        roles: [
          {
            id: 'role-anber',
            name: 'Anber',
            agent_id: 'claude-code',
            persona_prompt:
              '你是 Anber，一名产品调研专家。你的职责是用证据回答产品决策问题，而不是复述行业常识。【擅长】- 竞品分析：功能矩阵、定位差异、迭代节奏、商业模式与用户评价',
          },
        ],
      });

    try {
      renderSettings('opencode/minimax-m2.5-free', {
        multi_agent_enabled: true,
      });

      const row = await screen.findByTestId('custom-role-row-role-anber');
      expect(row).toHaveClass('min-w-0');
      const listContainer = screen.getByTestId('custom-roles-list-container');
      expect(listContainer).toHaveClass('min-w-0', 'overflow-hidden');
      const scrollBox = screen.getByTestId('custom-roles-scroll-box');
      expect(scrollBox).toHaveClass(
        'settings-bounded-list',
        'max-h-56',
        'overflow-y-auto'
      );

      const nameSpan = screen.getByText('Anber');
      expect(nameSpan).toHaveClass('shrink-0', 'truncate');

      const personaSpan = screen.getByText(/你是 Anber，一名产品调研专家/);
      expect(personaSpan).toHaveClass('min-w-0', 'flex-1', 'truncate');
    } finally {
      spy.mockRestore();
    }
  });

  it('displays Agent connection error card in New Role and Prompt Enhancement modals when loading session controls fails', async () => {
    const user = userEvent.setup();
    agentsApiMock.capabilityCatalog.mockRejectedValue(
      new Error("Executable `opencode` was not found in the system's PATH")
    );
    renderSettings('unused', {
      multi_agent_enabled: true,
      prompt_enhancement_agent_id: 'opencode',
    });

    await user.click(await screen.findByRole('button', { name: '新建角色' }));
    expect(
      await screen.findByTestId('session-creation-status-card')
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '取消' }));
    await user.click(screen.getByTestId('prompt-enhancement-edit-btn'));
    expect(
      await screen.findByTestId('session-creation-status-card')
    ).toBeInTheDocument();
  });
});
