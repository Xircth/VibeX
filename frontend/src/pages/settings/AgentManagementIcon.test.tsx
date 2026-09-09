import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
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

  it('constrains brand artwork to the wrapper outside settings pages', () => {
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/styles/legacy/index.css'),
      'utf8'
    );
    const unscopedFillSelectors: string[] = [];
    parse(stylesheet).walkRules((rule) => {
      const sizesArtwork =
        rule.selector.includes('.agent-management-brand-artwork') ||
        rule.selector.includes('.agent-management-svg-icon');
      const scopedToSettings =
        rule.selector.includes('.settings-page') ||
        rule.selector.includes('.plan-usage-page');
      if (!sizesArtwork || scopedToSettings) return;
      const decls = rule.nodes
        .filter((node) => node.type === 'decl')
        .map((node) => `${node.prop}:${node.value}`);
      if (
        decls.includes('width:100%') &&
        decls.includes('height:100%') &&
        decls.includes('max-width:100%') &&
        decls.includes('max-height:100%')
      ) {
        unscopedFillSelectors.push(rule.selector);
      }
    });

    expect(
      unscopedFillSelectors.some((selector) =>
        selector.includes('.agent-management-brand-artwork')
      )
    ).toBe(true);
    expect(
      unscopedFillSelectors.some((selector) =>
        selector.includes('.agent-management-svg-icon')
      )
    ).toBe(true);
  });
});
