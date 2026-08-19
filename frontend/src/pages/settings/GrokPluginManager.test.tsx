import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrokPluginSummaryView } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';

import { GrokPluginManager } from './GrokPluginManager';

vi.mock('@/features/agent-management', async () => {
  const actual = await vi.importActual<
    typeof import('@/features/agent-management')
  >('@/features/agent-management');
  return {
    ...actual,
    agentManagementApi: {
      ...actual.agentManagementApi,
      grokPlugins: vi.fn(),
      addGrokPlugin: vi.fn(),
      removeGrokPlugin: vi.fn(),
    },
  };
});

const summary: GrokPluginSummaryView = {
  home: '/tmp/.grok',
  plugins: [
    {
      name: 'ponytail',
      version: null,
      status: 'installed',
      path: '/tmp/.grok/installed-plugins/ponytail',
      source: 'https://github.com/example/ponytail',
      marketplace: null,
    },
  ],
};

describe('GrokPluginManager', () => {
  beforeEach(() => {
    vi.mocked(agentManagementApi.grokPlugins).mockResolvedValue(summary);
  });

  it('lists installed Grok plugins', async () => {
    render(<GrokPluginManager />);
    expect(
      await screen.findByRole('button', { name: 'ponytail' })
    ).toBeInTheDocument();
    expect(
      screen.getByText('https://github.com/example/ponytail')
    ).toBeInTheDocument();
  });

  it('installs from an official source spec', async () => {
    const user = userEvent.setup();
    vi.mocked(agentManagementApi.addGrokPlugin).mockResolvedValue(summary);
    render(<GrokPluginManager />);
    await screen.findByRole('button', { name: 'ponytail' });
    await user.type(screen.getByLabelText('来源'), 'owner/repo');
    await user.click(screen.getByRole('button', { name: '添加插件' }));
    expect(agentManagementApi.addGrokPlugin).toHaveBeenCalledWith('owner/repo');
  });
});
