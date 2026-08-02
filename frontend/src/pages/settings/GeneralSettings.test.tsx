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
  } as Config;
}

function renderSettings(model = 'opencode/minimax-m2.5-free') {
  userSystemMock.useUserSystem.mockReturnValue({
    config: promptEnhancementConfig(model),
    loading: false,
    updateAndSaveConfig: vi.fn(),
  });
  return render(<GeneralSettings />);
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
});
