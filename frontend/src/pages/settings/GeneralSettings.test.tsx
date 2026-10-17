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

  it('lists enabled Agents for prompt enhancement', async () => {
    renderSettings();

    await waitFor(() => {
      expect(agentManagementApiMock.bar).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByRole('combobox', { name: 'Agent' })).not.toBeDisabled();
  });

  it('refreshes the selected Agent session config on demand', async () => {
    const user = userEvent.setup();
    renderSettings('unused', { prompt_enhancement_agent_id: 'opencode' });

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

  it('persists a changed general preference through the shared config boundary', async () => {
    const user = userEvent.setup();
    const { updateAndSaveConfig } = renderSettings();

    await user.click(
      await screen.findByRole('switch', {
        name: '启动时提示未处理的崩溃报告',
      })
    );
    await user.click(screen.getByRole('button', { name: '保存' }));

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
    await user.click(screen.getByRole('button', { name: '保存' }));

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

  it('groups composer utilities, basics, sessions, and crash reports', () => {
    renderSettings();

    expect(
      screen.getByRole('heading', { name: '实用功能' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '基础功能' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '会话功能' })
    ).toBeInTheDocument();
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
    expect(screen.getByText('外部查看器')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: '创建时Fork已有会话' })
    ).toBeInTheDocument();
    expect(screen.getByText('本地会话导入')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: '启动时提示未处理的崩溃报告' })
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

  it('hides prompt-enhancement Agent config until the toggle is on', async () => {
    const user = userEvent.setup();
    renderSettings('unused', { prompt_enhancement_enabled: false });

    expect(
      screen.queryByRole('combobox', { name: 'Agent' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('使用自定义优化提示词')
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: '提示词优化' }));

    expect(screen.getByRole('combobox', { name: 'Agent' })).toBeInTheDocument();
    expect(screen.getByText('使用自定义优化提示词')).toBeInTheDocument();
  });

  it('keeps compact-context opt-in and persists it when enabled', async () => {
    const user = userEvent.setup();
    const { updateAndSaveConfig } = renderSettings();

    const toggle = await screen.findByRole('switch', {
      name: '手动压缩上下文',
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: '保存' }));

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
      name: '创建时Fork已有会话',
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: '保存' }));

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
});
