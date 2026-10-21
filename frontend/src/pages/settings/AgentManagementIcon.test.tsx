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

const BUILT_IN_AGENTS = [
  ['claude_code', 'Claude Code'],
  ['codex', 'Codex'],
  ['antigravity', 'Google Antigravity'],
  ['openclaw', 'OpenClaw'],
  ['opencode', 'OpenCode'],
  ['cline', 'Cline'],
  ['hermes', 'Hermes Agent'],
  ['codebuddy', 'CodeBuddy'],
  ['kimi_code', 'Kimi Code'],
  ['pi', 'Pi'],
  ['grok', 'Grok'],
  ['cursor', 'Cursor'],
  ['deepseek_harness', 'DeepSeek Harness'],
  ['qoder', 'Qoder'],
  ['kiro', 'Kiro CLI'],
  ['auggie', 'Auggie'],
  ['trae', 'TRAE CLI'],
  ['command_code', 'Command Code'],
  ['zcode', 'ZCode'],
  ['mimo_code', 'MiMo Code'],
] as const;

describe('AgentManagementIcon', () => {
  it.each(BUILT_IN_AGENTS)(
    'draws %s as an inline glyph that fills the caller box',
    (agentId, displayName) => {
      const { container } = render(
        <AgentManagementIcon
          agent={builtIn(agentId, displayName)}
          className="h-5 w-5"
        />
      );

      const frame = container.firstElementChild;
      expect(frame).toHaveClass('h-5', 'w-5');
      expect(screen.getByTitle(displayName)).toBeInTheDocument();
      const svg = frame!.querySelector('svg');
      expect(svg).toHaveAttribute('width', '100%');
      expect(svg).toHaveAttribute('height', '100%');
      expect(container.querySelector('img, picture')).toBeNull();
    }
  );

  it('does not let registry artwork hide a built-in mark', () => {
    for (const [agentId, displayName] of [
      ['grok', 'Grok'],
      ['kimi_code', 'Kimi Code'],
      ['cursor', 'Cursor'],
    ] as const) {
      const { container, unmount } = render(
        <AgentManagementIcon
          agent={{
            ...builtIn(agentId, displayName),
            icon_svg: "<svg data-mark='registry'></svg>",
          }}
          className="h-6 w-6"
        />
      );

      expect(screen.getByTitle(displayName)).toBeInTheDocument();
      expect(container.querySelector('[data-mark="registry"]')).toBeNull();
      expect(container.querySelector('img')).toBeNull();
      unmount();
    }
  });

  it('renders registry-only Agents from their runtime artwork', () => {
    const { container } = render(
      <AgentManagementIcon
        agent={{
          ...builtIn('vendor.agent', 'Vendor Agent'),
          icon_light: '/vendor-light.svg',
          icon_dark: '/vendor-dark.svg',
        }}
        className="h-5 w-5"
      />
    );

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      '/vendor-light.svg'
    );
  });

  it('constrains registry artwork to the wrapper outside settings pages', () => {
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

  it('keeps no per-Agent size calibration in the stylesheet', () => {
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/styles/legacy/index.css'),
      'utf8'
    );

    expect(stylesheet).not.toMatch(/agent-management-brand-icon\.is-/);
  });
});
