import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AgentManagementView } from 'shared/types';

import { AgentManagementIcon } from './AgentManagementIcon';

function builtIn(agentId: string, displayName: string): AgentManagementView {
  return {
    agent_id: agentId,
    display_name: displayName,
    description: '',
    icon_light: `/agents/${agentId}-light.svg`,
    icon_dark: `/agents/${agentId}-dark.svg`,
    icon_svg: null,
    source: 'built_in_profile',
    built_in: true,
    retired: false,
    enabled: true,
    position: 0,
    lifecycle: 'ready',
    authentication: 'not_required',
    runtime_version: '1.0.0',
    acp_version: '1.0.0',
    active_operation: null,
    rollback_available: false,
  };
}

describe('AgentManagementIcon', () => {
  it('uses the app brand artwork for built-in Agents instead of theme-switched white assets', () => {
    const { rerender } = render(
      <AgentManagementIcon
        agent={builtIn('claude_code', 'Claude Code')}
        className="h-6 w-6"
      />
    );

    expect(screen.getByTitle('Claude Code')).toBeInTheDocument();
    expect(document.querySelector('picture')).not.toBeInTheDocument();

    rerender(
      <AgentManagementIcon
        agent={builtIn('codex', 'Codex')}
        className="h-6 w-6"
      />
    );
    expect(screen.getByTitle('Codex')).toBeInTheDocument();
  });
});
