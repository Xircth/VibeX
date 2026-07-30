import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSettings } from './AgentSettings';

const api = vi.hoisted(() => ({
  bar: vi.fn(),
  registry: vi.fn(),
  refreshRegistry: vi.fn(),
  addAndInstall: vi.fn(),
  setEnabled: vi.fn(),
  reorder: vi.fn(),
  preflight: vi.fn(),
  repair: vi.fn(),
  update: vi.fn(),
  rollback: vi.fn(),
  cancelOperation: vi.fn(),
  uninstall: vi.fn(),
  remove: vi.fn(),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  diagnostics: vi.fn(),
  clearDiagnostics: vi.fn(),
}));

vi.mock('@/features/agent-management/api', () => ({
  agentManagementApi: api,
}));

vi.mock('@/lib/tauriApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/tauriApi')>();
  return { ...original, tauriListen: vi.fn().mockResolvedValue(vi.fn()) };
});

describe('AgentSettings', () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    api.bar.mockResolvedValue([
      {
        agent_id: 'codex',
        display_name: 'Codex',
        description: 'Codex ACP',
        icon_light: null,
        icon_dark: null,
        icon_svg: null,
        source: 'built_in_profile',
        built_in: true,
        retired: false,
        enabled: true,
        position: 0,
        lifecycle: 'ready',
        authentication: 'account',
        runtime_version: '1.0.0',
        acp_version: '1.0.0',
        active_operation: null,
        rollback_available: false,
      },
    ]);
    api.readConfig.mockResolvedValue({
      agent_id: 'codex',
      available: false,
      path: null,
      fields: [],
      applies_to_next_session: true,
    });
    api.diagnostics.mockResolvedValue([]);
  });

  it('renders the management projection as the only Agent settings source', async () => {
    render(<AgentSettings />);
    expect(await screen.findByRole('button', { name: 'Codex' })).toBeVisible();
    await waitFor(() => expect(api.readConfig).toHaveBeenCalledWith('codex'));
    expect(screen.getByText('已通过账号登录')).toBeInTheDocument();
  });
});
