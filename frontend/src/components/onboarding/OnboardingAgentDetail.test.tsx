import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentManagementView, AgentNativeConfigView } from 'shared/types';
import i18n from '@/i18n';
import { OnboardingAgentDetail } from './OnboardingAgentDetail';

const api = vi.hoisted(() => ({
  readConfig: vi.fn(),
  actions: vi.fn(),
  accountFlow: vi.fn(),
  writeConfig: vi.fn(),
  preflight: vi.fn(),
  environment: vi.fn(),
}));
vi.mock('@/features/agent-management', async (original) => ({
  ...(await original<typeof import('@/features/agent-management')>()),
  agentManagementApi: api,
}));
const agent: AgentManagementView = {
  agent_id: 'cline',
  display_name: 'Cline',
  description: '',
  source: 'built_in_profile',
  built_in: true,
  retired: false,
  enabled: true,
  position: 0,
  lifecycle: 'ready',
  authentication: 'api_key',
  runtime_version: null,
  acp_version: '1.0',
  icon_light: null,
  icon_dark: null,
  icon_svg: null,
  active_operation: null,
  rollback_available: false,
};
function config(revision: string): AgentNativeConfigView {
  return {
    agent_id: 'cline',
    available: true,
    settings_features: [],
    path: '/work/config.json',
    paths: ['/work/config.json'],
    files: [],
    applies_to_next_session: true,
    fields: [
      {
        id: 'enabled',
        label: 'Allow tools',
        description: '',
        kind: 'boolean',
        options: [],
        secret: false,
        path: '/work/config.json',
        present: true,
        value: 'false',
        masked_value: null,
        revision,
        surface: 'configuration',
      },
    ],
  };
}
describe('onboarding native Agent configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.actions.mockResolvedValue({ agent_id: 'cline', actions: [] });
    api.accountFlow.mockResolvedValue({ status: 'idle' });
    api.preflight.mockResolvedValue({ items: [] });
    api.environment.mockResolvedValue({
      agent_id: 'cline',
      revision: '0',
      entries: [],
    });
  });
  it('preserves a conflicting draft and overwrites only with the latest native revision', async () => {
    api.readConfig
      .mockResolvedValueOnce(config('old'))
      .mockResolvedValue(config('external'));
    api.writeConfig
      .mockRejectedValueOnce({ code: 'config_conflict' })
      .mockResolvedValue(config('saved'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <OnboardingAgentDetail
        agent={agent}
        onInstall={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onDirtyChange={vi.fn()}
      />
    );
    fireEvent.click(await screen.findByRole('switch', { name: 'Allow tools' }));
    const overwrite = await screen.findByRole('button', {
      name: i18n.t('settings:agents.overwriteExternal'),
    });
    expect(api.writeConfig).toHaveBeenCalledTimes(1);
    fireEvent.click(overwrite);
    await waitFor(() =>
      expect(api.writeConfig).toHaveBeenLastCalledWith({
        agent_id: 'cline',
        fields: { enabled: 'true' },
        base_field_revisions: { enabled: 'external' },
      })
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: i18n.t('settings:agents.overwriteExternal'),
        })
      ).not.toBeInTheDocument()
    );
    vi.restoreAllMocks();
  });
});
