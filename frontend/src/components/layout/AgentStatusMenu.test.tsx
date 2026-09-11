import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentManagementView } from 'shared/types';

import { AgentStatusMenu } from './AgentStatusMenu';

function agent(
  overrides: Partial<AgentManagementView> &
    Pick<AgentManagementView, 'agent_id' | 'display_name'>
): AgentManagementView {
  return {
    description: '',
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
    runtime_version: null,
    acp_version: null,
    active_operation: null,
    rollback_available: false,
    ...overrides,
  };
}

const agents = [
  agent({
    agent_id: 'claude_code',
    display_name: 'Claude Code',
    position: 0,
  }),
  agent({
    agent_id: 'codex',
    display_name: 'Codex',
    position: 1,
  }),
  agent({
    agent_id: 'opencode',
    display_name: 'OpenCode',
    enabled: false,
    position: 2,
  }),
];

describe('AgentStatusMenu', () => {
  it('shows only the default Agent until hover reveals every enabled Agent', () => {
    render(<AgentStatusMenu agents={agents} defaultAgentId="codex" />);

    const trigger = screen.getByRole('button', {
      name: /默认 Agent：Codex，已就绪/,
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list');
    expect(
      within(list).getByText('Claude Code', { selector: 'span' })
    ).toBeInTheDocument();
    expect(
      within(list).getByText('Codex', { selector: 'span' })
    ).toBeInTheDocument();
    expect(within(list).queryByText('OpenCode')).not.toBeInTheDocument();
  });

  it('omits uninstalled Agents from the enabled status list', () => {
    render(
      <AgentStatusMenu
        agents={[
          ...agents,
          agent({
            agent_id: 'pi',
            display_name: 'Pi',
            lifecycle: 'uninstalled',
            position: 3,
          }),
          agent({
            agent_id: 'cursor',
            display_name: 'Cursor',
            lifecycle: 'needs_auth',
            position: 4,
          }),
        ]}
        defaultAgentId="codex"
      />
    );

    fireEvent.mouseEnter(
      screen.getByRole('button', {
        name: /默认 Agent：Codex，已就绪/,
      })
    );

    const list = screen.getByRole('list');
    expect(
      within(list).getByText('Claude Code', { selector: 'span' })
    ).toBeInTheDocument();
    expect(
      within(list).getByText('Cursor', { selector: 'span' })
    ).toBeInTheDocument();
    expect(within(list).queryByText('Pi')).not.toBeInTheDocument();
    expect(within(list).queryByText('OpenCode')).not.toBeInTheDocument();
  });

  it('also expands for keyboard focus', () => {
    render(<AgentStatusMenu agents={agents} defaultAgentId="codex" />);

    const trigger = screen.getByRole('button', {
      name: /默认 Agent：Codex，已就绪/,
    });
    fireEvent.focus(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('list')).toBeInTheDocument();
  });

  it('shows an update cue and opens the matching Agent settings page', () => {
    const onOpenAgentSettings = vi.fn();
    render(
      <AgentStatusMenu
        agents={agents}
        defaultAgentId="codex"
        updatableAgentIds={new Set(['claude_code'])}
        onOpenAgentSettings={onOpenAgentSettings}
      />
    );

    const trigger = screen.getByRole('button', {
      name: /默认 Agent：Codex，已就绪，有更新/,
    });
    expect(within(trigger).getByText('有更新')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '可更新' })).toBeNull();

    fireEvent.mouseEnter(trigger);

    const claudeRow = screen.getByRole('listitem', { name: /Claude Code/ });
    const updateButton = within(claudeRow).getByRole('button', {
      name: '可更新',
    });
    expect(
      within(screen.getByRole('listitem', { name: /Codex/ })).queryByRole(
        'button',
        { name: '可更新' }
      )
    ).toBeNull();

    fireEvent.click(updateButton);
    expect(onOpenAgentSettings).toHaveBeenCalledWith('claude_code');
  });
});
