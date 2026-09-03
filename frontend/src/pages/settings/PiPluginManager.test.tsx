import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiPluginSummaryView } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';

import { PiPluginManager } from './PiPluginManager';

vi.mock('@/features/agent-management', async () => {
  const actual = await vi.importActual<
    typeof import('@/features/agent-management')
  >('@/features/agent-management');
  return {
    ...actual,
    agentManagementApi: {
      ...actual.agentManagementApi,
      piPlugins: vi.fn(),
      addPiPlugin: vi.fn(),
      removePiPlugin: vi.fn(),
    },
  };
});

const summary: PiPluginSummaryView = {
  home: '/tmp/.pi/agent',
  plugins: [
    {
      source: 'npm:pi-package-manager',
      name: 'pi-package-manager',
      version: null,
      kind: 'npm',
      path: null,
    },
  ],
};

describe('PiPluginManager', () => {
  beforeEach(() => {
    vi.mocked(agentManagementApi.piPlugins).mockResolvedValue(summary);
  });

  it('lists installed Pi packages', async () => {
    render(<PiPluginManager />);
    expect(
      await screen.findByRole('button', { name: 'pi-package-manager' })
    ).toBeInTheDocument();
    expect(screen.getByText('npm:pi-package-manager')).toBeInTheDocument();
  });

  it('installs from an official package spec', async () => {
    const user = userEvent.setup();
    vi.mocked(agentManagementApi.addPiPlugin).mockResolvedValue(summary);
    render(<PiPluginManager />);
    await screen.findByRole('button', { name: 'pi-package-manager' });
    await user.type(screen.getByLabelText('来源'), 'npm:@foo/bar');
    await user.click(screen.getByRole('button', { name: '添加插件' }));
    expect(agentManagementApi.addPiPlugin).toHaveBeenCalledWith('npm:@foo/bar');
  });
});
