import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentManagementView } from 'shared/types';

import { AgentBar } from './AgentBar';

function agent(
  agentId: string,
  displayName: string,
  position: number,
  builtIn = true
): AgentManagementView {
  return {
    agent_id: agentId,
    display_name: displayName,
    description: `${displayName} description`,
    icon_light: null,
    icon_dark: null,
    icon_svg: null,
    source: builtIn ? 'built_in_profile' : 'official_registry',
    built_in: builtIn,
    retired: false,
    enabled: true,
    position,
    lifecycle: 'ready',
    authentication: 'not_required',
    runtime_version: '1.0.0',
    acp_version: '1.0.0',
    active_operation: null,
    rollback_available: false,
  };
}

describe('AgentBar', () => {
  it('keeps all Agents in one ordered strip with a sticky final add control', async () => {
    const onSelect = vi.fn();
    render(
      <AgentBar
        agents={[
          agent('claude_code', 'Claude Code', 0),
          agent('codex', 'Codex', 1),
          agent('opencode', 'OpenCode', 2),
          agent('pi', 'Pi', 3),
          agent('vendor.agent', 'Vendor Agent', 4, false),
        ]}
        selectedAgentId="codex"
        registryOpen={false}
        onSelect={onSelect}
        onOpenRegistry={vi.fn()}
      />
    );

    const controls = screen.getAllByRole('button');
    expect(
      controls.map((control) => control.getAttribute('aria-label'))
    ).toEqual([
      'Claude Code',
      'Codex',
      'OpenCode',
      'Pi',
      'Vendor Agent',
      '添加 Agent',
    ]);
    expect(screen.getByRole('button', { name: 'Codex' })).toHaveAttribute(
      'aria-current',
      'true'
    );
    expect(
      screen
        .getByRole('button', { name: '添加 Agent' })
        .closest('.agent-management-bar-scroll')
    ).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Vendor Agent' }));
    expect(onSelect).toHaveBeenCalledWith('vendor.agent');
  });
});
