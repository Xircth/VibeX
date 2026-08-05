import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorType, SoundFile, type Config } from 'shared/types';

import { GeneralSettings } from './GeneralSettings';

const configApiMock = vi.hoisted(() => ({
  checkEditorAvailability: vi.fn(),
  listPromptEnhancementModels: vi.fn(),
  refreshPromptEnhancementModels: vi.fn(),
  playNotificationSound: vi.fn(),
}));

const userSystemMock = vi.hoisted(() => ({
  useUserSystem: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  configApi: configApiMock,
}));

vi.mock('@/components/ConfigProvider', () => userSystemMock);

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
    },
    prompt_enhancement_enabled: true,
    prompt_enhancement_model: model,
    prompt_enhancement_prompt: null,
    crash_reports_enabled: false,
  } as Config;
}

function renderSettings(model = 'opencode/minimax-m2.5-free') {
  const updateAndSaveConfig = vi.fn().mockResolvedValue(true);
  userSystemMock.useUserSystem.mockReturnValue({
    config: promptEnhancementConfig(model),
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
    userSystemMock.useUserSystem.mockReset();
    configApiMock.checkEditorAvailability.mockResolvedValue({
      available: true,
    });
    configApiMock.playNotificationSound.mockResolvedValue(undefined);
  });

  it('does not fabricate choices when the matching capability catalog is empty', async () => {
    configApiMock.listPromptEnhancementModels.mockResolvedValue({ models: [] });

    renderSettings();

    await waitFor(() => {
      expect(configApiMock.listPromptEnhancementModels).toHaveBeenCalledTimes(
        1
      );
    });

    expect(
      screen.getByText(
        /已保存的模型 opencode\/minimax-m2\.5-free 不在当前已验证的 Agent 目录中/
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Agent 模型' })).toBeDisabled();
    expect(screen.queryByText('opencode/claude-opus-4-7')).toBeNull();
    expect(configApiMock.refreshPromptEnhancementModels).not.toHaveBeenCalled();
  });

  it('uses the explicit verified catalog refresh before exposing new models', async () => {
    const user = userEvent.setup();
    configApiMock.listPromptEnhancementModels.mockResolvedValue({ models: [] });
    configApiMock.refreshPromptEnhancementModels.mockResolvedValue({
      models: ['openai/gpt-5.6-sol'],
    });

    renderSettings();
    await waitFor(() => {
      expect(configApiMock.listPromptEnhancementModels).toHaveBeenCalledTimes(
        1
      );
    });

    await user.click(screen.getByRole('button', { name: '刷新模型列表' }));

    await waitFor(() => {
      expect(
        configApiMock.refreshPromptEnhancementModels
      ).toHaveBeenCalledTimes(1);
      expect(configApiMock.listPromptEnhancementModels).toHaveBeenCalledTimes(
        1
      );
    });

    expect(
      screen.getByRole('combobox', { name: 'Agent 模型' })
    ).not.toBeDisabled();
  });

  it('persists a changed general preference through the shared config boundary', async () => {
    const user = userEvent.setup();
    configApiMock.listPromptEnhancementModels.mockResolvedValue({ models: [] });
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

  it('enables conversation collapse preferences by default and persists opt-out', async () => {
    const user = userEvent.setup();
    configApiMock.listPromptEnhancementModels.mockResolvedValue({ models: [] });
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
    configApiMock.listPromptEnhancementModels.mockResolvedValue({ models: [] });
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
});
