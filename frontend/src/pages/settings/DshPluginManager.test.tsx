import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DshPluginSummaryView } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';

import { DshPluginManager } from './DshPluginManager';

vi.mock('@/features/agent-management', async () => {
  const actual = await vi.importActual<
    typeof import('@/features/agent-management')
  >('@/features/agent-management');
  return {
    ...actual,
    agentManagementApi: {
      ...actual.agentManagementApi,
      dshPlugins: vi.fn(),
      addDshPlugin: vi.fn(),
      removeDshPlugin: vi.fn(),
    },
  };
});

const summary: DshPluginSummaryView = {
  profile: 'default',
  profile_dir: '/tmp/.dsh/profiles/default',
  plugins: [
    {
      name: '@deepseek-ai/dsh-base',
      version: '0.1.0-rc.6',
      reserved: true,
      source: 'default',
      kind: 'plugin',
      path: null,
      summary: null,
    },
    {
      name: 'dsh-hello-plugin',
      version: '0.1.0',
      reserved: false,
      source: 'default',
      kind: 'plugin',
      path: null,
      summary: null,
    },
  ],
};

describe('DshPluginManager', () => {
  beforeEach(() => {
    vi.mocked(agentManagementApi.dshPlugins).mockResolvedValue(summary);
  });

  it('lists official bundles and hides reserved uninstall', async () => {
    render(<DshPluginManager />);

    expect(
      await screen.findByRole('button', { name: /@deepseek-ai\/dsh-base/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /dsh-hello-plugin/ })
    ).toBeInTheDocument();
    expect(screen.queryByText('Skill')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '移除 @deepseek-ai/dsh-base' })
    ).not.toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /dsh-hello-plugin/ }));
    expect(
      screen.getByRole('button', { name: '移除 dsh-hello-plugin' })
    ).toBeInTheDocument();
  });

  it('adds a plugin spec', async () => {
    const user = userEvent.setup();
    vi.mocked(agentManagementApi.addDshPlugin).mockResolvedValue(summary);
    render(<DshPluginManager />);

    await screen.findByRole('button', { name: /dsh-hello-plugin/ });
    await user.type(screen.getByLabelText('包名'), 'dsh-weather');
    await user.click(screen.getByRole('button', { name: '添加插件' }));

    expect(agentManagementApi.addDshPlugin).toHaveBeenCalledWith('dsh-weather');
  });
});
