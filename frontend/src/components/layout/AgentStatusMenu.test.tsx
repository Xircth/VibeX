import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

  it('also expands for keyboard focus', () => {
    render(<AgentStatusMenu agents={agents} defaultAgentId="codex" />);

    const trigger = screen.getByRole('button', {
      name: /默认 Agent：Codex，已就绪/,
    });
    fireEvent.focus(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('list')).toBeInTheDocument();
  });
});
