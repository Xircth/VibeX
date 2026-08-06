import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentManagementApi } from '@/features/agent-management';

import { OpenCodePluginHealth } from './OpenCodePluginHealth';

describe('OpenCodePluginHealth', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows missing plugins and installs the selected declaration', async () => {
    const missing = {
      config_path: '/home/me/.config/opencode/opencode.json',
      cache_dir: '/home/me/.cache/opencode',
      has_project_config_hint: false,
      plugins: [
        {
          name: 'opencode-foo',
          declared_spec: 'opencode-foo@latest',
          installed_version: null,
          status: 'missing' as const,
        },
      ],
    };
    const installed = {
      ...missing,
      plugins: [
        {
          ...missing.plugins[0],
          declared_spec: 'opencode-foo@1.2.3',
          installed_version: '1.2.3',
          status: 'installed' as const,
        },
      ],
    };
    vi.spyOn(agentManagementApi, 'openCodePlugins').mockResolvedValue(missing);
    const install = vi
      .spyOn(agentManagementApi, 'installOpenCodePlugins')
      .mockResolvedValue(installed);
    const onChanged = vi.fn();
    const user = userEvent.setup();

    render(<OpenCodePluginHealth onChanged={onChanged} />);

    expect(await screen.findByText('opencode-foo')).toBeInTheDocument();
    expect(screen.getByText(/缺失/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '安装 opencode-foo' }));

    await waitFor(() => expect(install).toHaveBeenCalledWith(['opencode-foo']));
    expect(await screen.findByText(/已安装 · 1\.2\.3/)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledOnce();
  });
});
