import { render, screen, waitFor } from '@testing-library/react';
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

vi.mock('@/features/agents/sessionControlsQuery', () => ({
  loadAgentSessionControlsCatalog: () => agentsApiMock.capabilityCatalog(),
}));

vi.mock('@/components/ConfigProvider', () => userSystemMock);

vi.mock('@/components/sessions/ImportLocalSessionsDialog', () => ({
  ImportLocalSessionsDialog: ({ open }: { open: boolean }) =>
    open ? <div>import-dialog</div> : null,
}));

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

describe('GeneralSettings Agent model catalogs', () => {
  beforeEach(() => {
    for (const fn of Object.values(configApiMock)) {
      fn.mockReset();
    }
    agentManagementApiMock.bar.mockReset();
    agentsApiMock.refreshCapabilityCatalog.mockReset();
    agentsApiMock.capabilityCatalog.mockReset();
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

  it('enables conversation collapse preferences by default and persists opt-out', async () => {
    const user = userEvent.setup();
    const { updateAndSaveConfig } = renderSettings();

    const filesChangedToggle = await screen.findByRole('switch', {
      name: '`files changed` 默认折叠',
    });
    const aiMessageToggle = screen.getByRole('switch', {
      name: 'AI 消息默认折叠',
    });
    expect(filesChangedToggle).toBeChecked();
    expect(aiMessageToggle).toBeChecked();

    await user.click(filesChangedToggle);
    await user.click(aiMessageToggle);
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(updateAndSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          files_changed_default_collapsed: false,
          ai_message_default_collapsed: false,
        })
      );
    });
  });

  it('keeps previous-session continuation opt-in and persists it when enabled', async () => {
    const user = userEvent.setup();
    const { updateAndSaveConfig } = renderSettings();

    const toggle = await screen.findByRole('switch', {
      name: '创建会话时允许选择先前的会话以继续',
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

    expect(screen.getByText('本地会话')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '导入' }));
    expect(screen.getByText('import-dialog')).toBeInTheDocument();
  });
});
