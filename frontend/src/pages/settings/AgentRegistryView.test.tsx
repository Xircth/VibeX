import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRegistryView } from 'shared/types';

import { AgentRegistryViewPanel } from './AgentRegistryView';

const view: AgentRegistryView = {
  snapshot_id: 'snapshot-1',
  fetched_at: '2026-07-29T12:00:00Z',
  fresh: true,
  refresh_error: null,
  installed: [
    {
      agent_id: 'codex',
      registry_id: 'codex-acp',
      display_name: 'Codex',
      description: 'Codex ACP',
      version: '1.0.0',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      built_in: true,
      added: true,
      installed: true,
      platform_supported: true,
    },
    {
      agent_id: 'alpha',
      registry_id: 'alpha',
      display_name: 'Alpha',
      description: 'Alpha ACP',
      version: '1.0.0',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      built_in: false,
      added: true,
      installed: false,
      platform_supported: true,
    },
  ],
  uninstalled: [
    {
      agent_id: 'zeta',
      registry_id: 'zeta',
      display_name: 'Zeta',
      description: 'Zeta ACP',
      version: '2.0.0',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      built_in: false,
      added: false,
      installed: false,
      platform_supported: true,
    },
    {
      agent_id: 'beta',
      registry_id: 'beta',
      display_name: 'Beta',
      description: 'Beta ACP',
      version: '1.0.0',
      icon_light: null,
      icon_dark: null,
      icon_svg: null,
      built_in: false,
      added: false,
      installed: false,
      platform_supported: false,
    },
  ],
};

describe('AgentRegistryViewPanel', () => {
  it('exposes one searchable control and compact installation statuses', async () => {
    render(
      <AgentRegistryViewPanel
        view={view}
        loading={false}
        addingAgentId={null}
        onRefresh={vi.fn()}
        onAdd={vi.fn()}
      />
    );

    const search = screen.getByRole('searchbox', { name: '搜索 Agent' });
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
    expect(screen.getAllByRole('status')).toHaveLength(view.installed.length);

    await userEvent.type(search, 'Alpha');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('separates independently sorted tabs and adds supported Agents inline', async () => {
    const onAdd = vi.fn();
    render(
      <AgentRegistryViewPanel
        view={view}
        loading={false}
        addingAgentId={null}
        onRefresh={vi.fn()}
        onAdd={onAdd}
      />
    );

    expect(
      screen.getAllByRole('listitem').map((row) => row.textContent)
    ).toEqual([
      expect.stringContaining('Codex'),
      expect.stringContaining('Alpha'),
    ]);

    await userEvent.click(screen.getByRole('tab', { name: /未安装/ }));
    expect(
      screen.getAllByRole('listitem').map((row) => row.textContent)
    ).toEqual([
      expect.stringContaining('Beta'),
      expect.stringContaining('Zeta'),
    ]);
    expect(screen.getByRole('button', { name: '安装 Beta' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '安装 Zeta' }));
    expect(onAdd).toHaveBeenCalledWith(view.uninstalled[0]);
  });
});
