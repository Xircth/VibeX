import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AgentManagementView } from 'shared/types';

import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';

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

  it('does not let a registry svg hide the built-in Grok, Kimi, or Cursor marks', () => {
    for (const [agentId, displayName, src] of [
      ['grok', 'Grok', '/agents/grok.svg'],
      ['kimi_code', 'Kimi Code', '/agents/kimi.svg'],
      ['cursor', 'Cursor', '/agents/cursor-light.svg'],
    ] as const) {
      const { container, unmount } = render(
        <AgentManagementIcon
          agent={{
            ...builtIn(agentId, displayName),
            icon_light: src,
            icon_dark: src,
            icon_svg: "<svg data-mark='registry'></svg>",
          }}
          className="h-6 w-6"
        />
      );

      expect(container.querySelector('img')).toHaveAttribute('src', src);
      expect(container.querySelector('[data-mark="registry"]')).toBeNull();
      unmount();
    }
  });
});
