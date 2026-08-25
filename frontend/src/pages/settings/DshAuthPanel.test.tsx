import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DshProvidersView } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';

import { clearAllAgentSettingsDrafts } from './agentSettingsDraftRetention';
import { pickAuthModeTab } from './agentSettingsTestUtils';
import { DshAuthPanel } from './DshAuthPanel';

vi.mock('@/features/agent-management', async () => {
  const actual = await vi.importActual<
    typeof import('@/features/agent-management')
  >('@/features/agent-management');
  return {
    ...actual,
    agentManagementApi: {
      ...actual.agentManagementApi,
      dshProviders: vi.fn(),
      saveDshProvider: vi.fn(),
      setAuthMode: vi.fn(),
      authMode: vi.fn(),
      discoverDshModels: vi.fn(),
    },
  };
});

const view: DshProvidersView = {
  settings_path: '/tmp/.dsh/settings.yaml',
  credentials_path: '/tmp/.dsh/.credentials.yaml',
  default_provider: 'deepseek-official',
  default_model: 'deepseek-v4-flash',
  providers: [
    {
      id: 'deepseek-official',
      display_name: 'DeepSeek',
      kind: 'official',
      notes: null,
      api: null,
      base_url: null,
      api_key_env: 'DEEPSEEK_API_KEY',
      credential_present: true,
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
    },
  ],
  catalog: [],
};

describe('DshAuthPanel', () => {
  beforeEach(() => {
    clearAllAgentSettingsDrafts();
    vi.mocked(agentManagementApi.dshProviders).mockResolvedValue(view);
    vi.mocked(agentManagementApi.authMode).mockResolvedValue({
      agent_id: 'deepseek_harness',
      mode: 'deepseek',
      modes: ['deepseek', 'custom'],
      options: [],
      credential_env: 'DEEPSEEK_API_KEY',
      credential_present: true,
    });
    vi.mocked(agentManagementApi.setAuthMode).mockResolvedValue({
      agent_id: 'deepseek_harness',
      mode: 'deepseek',
      modes: ['deepseek', 'custom'],
      options: [],
      credential_env: 'DEEPSEEK_API_KEY',
      credential_present: true,
    });
    vi.mocked(agentManagementApi.saveDshProvider).mockResolvedValue(view);
  });

  it('saves the official DeepSeek API key and model', async () => {
    const user = userEvent.setup();
    vi.mocked(agentManagementApi.authMode).mockResolvedValue({
      agent_id: 'deepseek_harness',
      mode: 'deepseek',
      modes: ['deepseek', 'custom'],
      options: [],
      credential_env: 'DEEPSEEK_API_KEY',
      credential_present: true,
    });
    render(<DshAuthPanel />);

    expect(
      await screen.findByRole('tab', { name: 'DeepSeek' })
    ).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '自定义' })).toHaveAttribute(
      'aria-selected',
      'false'
    );
    expect(
      await screen.findByDisplayValue('https://api.deepseek.com')
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('API Key'), 'sk-test');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(agentManagementApi.setAuthMode).toHaveBeenCalledWith(
      'deepseek_harness',
      'deepseek',
      'sk-test'
    );
    expect(agentManagementApi.saveDshProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'deepseek-official',
        api_key: 'sk-test',
        set_default: true,
      })
    );
  });

  it('shows custom provider fields', async () => {
    vi.mocked(agentManagementApi.authMode).mockResolvedValue({
      agent_id: 'deepseek_harness',
      mode: 'custom',
      modes: ['deepseek', 'custom'],
      options: [],
      credential_env: 'DEEPSEEK_API_KEY',
      credential_present: false,
    });
    render(<DshAuthPanel />);

    expect(await screen.findByRole('tab', { name: '自定义' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(await screen.findByLabelText('显示名称')).toBeInTheDocument();
    expect(screen.getByLabelText('备注')).toBeInTheDocument();
    expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
  });

  it('keeps an unsaved custom endpoint after the panel remounts', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DshAuthPanel />);

    expect(
      await screen.findByDisplayValue('https://api.deepseek.com')
    ).toBeInTheDocument();

    await pickAuthModeTab(user, '自定义');
    await user.type(
      screen.getByLabelText('Base URL'),
      'https://example.com/v1'
    );

    unmount();
    render(<DshAuthPanel />);

    expect(await screen.findByLabelText('Base URL')).toHaveValue(
      'https://example.com/v1'
    );
    expect(
      screen.queryByDisplayValue('https://api.deepseek.com')
    ).not.toBeInTheDocument();
  });
});
