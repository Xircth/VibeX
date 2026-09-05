import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
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

function installAgentBarStyles() {
  const stylesheet = readFileSync(
    resolve(process.cwd(), 'src/styles/legacy/index.css'),
    'utf8'
  );
  const relevantRules: string[] = [];
  parse(stylesheet).walkRules((rule) => {
    if (rule.selector.includes('.agent-management')) {
      relevantRules.push(rule.toString());
    }
  });
  const style = document.createElement('style');
  style.textContent = relevantRules.join('\n');
  document.head.append(style);
  return style;
}

describe('AgentBar', () => {
  it('nudges an icon with Alt+Arrow and persists the new order', () => {
    const onReorder = vi.fn();
    render(
      <AgentBar
        agents={[
          agent('claude_code', 'Claude Code', 0),
          agent('codex', 'Codex', 1),
          agent('pi', 'Pi', 2),
        ]}
        selectedAgentId="claude_code"
        registryOpen={false}
        onSelect={vi.fn()}
        onOpenRegistry={vi.fn()}
        onReorder={onReorder}
      />
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'Codex' }), {
      key: 'ArrowLeft',
      altKey: true,
    });
    expect(onReorder).toHaveBeenCalledWith(['codex', 'claude_code', 'pi']);
    expect(
      screen
        .getAllByRole('button')
        .map((control) => control.getAttribute('aria-label'))
    ).toEqual(['Codex', 'Claude Code', 'Pi', '添加 Agent']);
  });

  it('navigates on a plain pointer click (no drag) on an agent icon', () => {
    const onSelect = vi.fn();
    render(
      <AgentBar
        agents={[
          agent('claude_code', 'Claude Code', 0),
          agent('codex', 'Codex', 1),
        ]}
        selectedAgentId="claude_code"
        registryOpen={false}
        onSelect={onSelect}
        onOpenRegistry={vi.fn()}
        onReorder={vi.fn()}
      />
    );

    const codex = screen.getByRole('button', { name: 'Codex' });
    fireEvent.pointerDown(codex, { pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(codex, { pointerId: 1 });
    fireEvent.click(codex);
    expect(onSelect).toHaveBeenCalledWith('codex');
  });

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
        onReorder={vi.fn()}
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

  it('calibrates brand marks and shows only the scrollbar thumb', () => {
    const style = installAgentBarStyles();
    const rendered = render(
      <div className="settings-page">
        <AgentBar
          agents={[
            {
              ...agent('cline', 'Cline', 0),
              icon_light: '/agents/cline.svg',
              icon_dark: '/agents/cline.svg',
            },
            {
              ...agent('hermes', 'Hermes Agent', 1),
              icon_light: '/agents/hermes.png',
              icon_dark: '/agents/hermes.png',
            },
            {
              ...agent('codebuddy', 'CodeBuddy', 2),
              icon_light: '/agents/codebuddy.svg',
              icon_dark: '/agents/codebuddy.svg',
            },
            {
              ...agent('grok', 'Grok', 3),
              icon_light: '/agents/grok.svg',
              icon_dark: '/agents/grok.svg',
            },
            {
              ...agent('cursor', 'Cursor', 4),
              icon_light: '/agents/cursor-light.svg',
              icon_dark: '/agents/cursor-dark.svg',
            },
          ]}
          selectedAgentId="hermes"
          registryOpen={false}
          onSelect={vi.fn()}
          onOpenRegistry={vi.fn()}
          onReorder={vi.fn()}
        />
      </div>
    );

    try {
      for (const name of ['Cline', 'CodeBuddy', 'Grok']) {
        const artwork = screen
          .getByRole('button', { name })
          .querySelector('img');
        expect(artwork).not.toBeNull();
        expect(getComputedStyle(artwork!).width).toBe('22px');
        expect(getComputedStyle(artwork!).height).toBe('22px');
      }

      const hermesArtwork = screen
        .getByRole('button', { name: 'Hermes Agent' })
        .querySelector('img');
      expect(hermesArtwork).toHaveAttribute('src', '/agents/hermes.png');
      expect(getComputedStyle(hermesArtwork!).width).toBe('28px');
      expect(getComputedStyle(hermesArtwork!).height).toBe('28px');

      const cursorArtwork = screen
        .getByRole('button', { name: 'Cursor' })
        .querySelector('img');
      expect(getComputedStyle(cursorArtwork!).width).toBe('24px');
      expect(getComputedStyle(cursorArtwork!).height).toBe('24px');

      for (const name of [
        'Cline',
        'Hermes Agent',
        'CodeBuddy',
        'Grok',
        'Cursor',
      ]) {
        const button = screen.getByRole('button', { name });
        const frame = button.querySelector('.agent-management-brand-icon');
        const artwork = button.querySelector('img');
        expect(frame?.tagName).toBe('SPAN');
        expect(frame).toContainElement(artwork);
        expect(getComputedStyle(frame!).position).toBe('relative');
        expect(getComputedStyle(artwork!).position).toBe('absolute');
        expect(getComputedStyle(artwork!).top).toBe('50%');
        expect(getComputedStyle(artwork!).left).toBe('50%');
        expect(getComputedStyle(artwork!).transform).toBe(
          'translate(-50%, -50%)'
        );
      }

      const rail = document.querySelector('.agent-management-bar-surface');
      const scroller = document.querySelector('.agent-management-bar-scroll');
      expect(rail).not.toBeNull();
      expect(scroller).not.toBeNull();
      expect(rail!.contains(scroller)).toBe(false);
      expect(getComputedStyle(rail!).bottom).toBe('0px');
      expect(getComputedStyle(scroller!).height).toBe('66px');
      expect(style.textContent).toContain(
        '.agent-management-bar-scroll::-webkit-scrollbar'
      );
      expect(style.textContent).toContain('height: 6px');
      expect(style.textContent).not.toContain('border-top-width: 10px');
      expect(style.textContent).toMatch(
        /agent-management-bar-scroll::-webkit-scrollbar-track\s*,[\s\S]*background:\s*transparent;/
      );
      expect(style.textContent).toMatch(
        /agent-management-bar-scroll::-webkit-scrollbar-thumb\s*{[^}]*background:\s*hsl\(var\(--border-strong\) \/ 0\.55\);/
      );
      expect(style.textContent).not.toMatch(
        /agent-management-bar-scroll:hover::-webkit-scrollbar-thumb/
      );
    } finally {
      rendered.unmount();
      style.remove();
    }
  });
});
