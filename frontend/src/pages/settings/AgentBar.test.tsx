import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function manyAgents(count: number) {
  return Array.from({ length: count }, (_, index) =>
    agent(`vendor.agent${index}`, `Agent ${index}`, index, false)
  );
}

/** jsdom has no layout; report a fixed width for the paging viewport. */
let viewportWidthSpy: ReturnType<typeof vi.spyOn> | null = null;

function mockViewportWidth(width: number) {
  viewportWidthSpy = vi
    .spyOn(Element.prototype, 'clientWidth', 'get')
    .mockImplementation(function (this: Element) {
      return this.classList.contains('agent-management-bar-viewport')
        ? width
        : 0;
    });
}

function renderBar(
  agents: AgentManagementView[],
  selectedAgentId: string | null,
  overrides: Partial<Parameters<typeof AgentBar>[0]> = {}
) {
  return render(
    <AgentBar
      agents={agents}
      selectedAgentId={selectedAgentId}
      registryOpen={false}
      onSelect={vi.fn()}
      onReorder={vi.fn()}
      {...overrides}
    />
  );
}

function currentPage() {
  return document
    .querySelector<HTMLElement>('.agent-management-bar-track')!
    .style.getPropertyValue('--agent-bar-page');
}

describe('AgentBar', () => {
  afterEach(() => {
    viewportWidthSpy?.mockRestore();
    viewportWidthSpy = null;
  });

  it('nudges an icon with Alt+Arrow and persists the new order', () => {
    const onReorder = vi.fn();
    renderBar(
      [
        agent('claude_code', 'Claude Code', 0),
        agent('codex', 'Codex', 1),
        agent('pi', 'Pi', 2),
      ],
      'claude_code',
      { onReorder }
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
    ).toEqual(['Codex', 'Claude Code', 'Pi']);
  });

  it('navigates on a plain pointer click (no drag) on an agent icon', () => {
    const onSelect = vi.fn();
    renderBar(
      [agent('claude_code', 'Claude Code', 0), agent('codex', 'Codex', 1)],
      'claude_code',
      { onSelect }
    );

    const codex = screen.getByRole('button', { name: 'Codex' });
    fireEvent.pointerDown(codex, { pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(codex, { pointerId: 1 });
    fireEvent.click(codex);
    expect(onSelect).toHaveBeenCalledWith('codex');
  });

  it('keeps all Agents in one ordered strip and leaves adding to the toolbar', async () => {
    const onSelect = vi.fn();
    renderBar(
      [
        agent('claude_code', 'Claude Code', 0),
        agent('codex', 'Codex', 1),
        agent('opencode', 'OpenCode', 2),
        agent('pi', 'Pi', 3),
        agent('vendor.agent', 'Vendor Agent', 4, false),
      ],
      'codex',
      { onSelect }
    );

    expect(
      screen
        .getAllByRole('button')
        .map((control) => control.getAttribute('aria-label'))
    ).toEqual(['Claude Code', 'Codex', 'OpenCode', 'Pi', 'Vendor Agent']);
    expect(screen.getByRole('button', { name: 'Codex' })).toHaveAttribute(
      'aria-current',
      'true'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Vendor Agent' }));
    expect(onSelect).toHaveBeenCalledWith('vendor.agent');
  });

  it('shows the name beside the selected Agent icon only', () => {
    renderBar(
      [agent('claude_code', 'Claude Code', 0), agent('codex', 'Codex', 1)],
      'codex'
    );

    const selected = screen.getByRole('button', { name: 'Codex' });
    const other = screen.getByRole('button', { name: 'Claude Code' });
    expect(selected).toHaveClass('is-selected');
    expect(other).not.toHaveClass('is-selected');
    expect(
      selected.querySelector('.agent-management-bar-label')
    ).toHaveTextContent('Codex');
  });

  it('does not show the selection while the registry is open', () => {
    renderBar([agent('codex', 'Codex', 0)], 'codex', { registryOpen: true });

    expect(screen.getByRole('button', { name: 'Codex' })).not.toHaveClass(
      'is-selected'
    );
  });

  it('draws every built-in Agent from the shared glyph at the same size', () => {
    renderBar(
      [
        agent('cline', 'Cline', 0),
        agent('hermes', 'Hermes Agent', 1),
        agent('codebuddy', 'CodeBuddy', 2),
        agent('grok', 'Grok', 3),
        agent('cursor', 'Cursor', 4),
      ],
      'hermes'
    );

    for (const name of [
      'Cline',
      'Hermes Agent',
      'CodeBuddy',
      'Grok',
      'Cursor',
    ]) {
      const button = screen.getByRole('button', { name });
      const icon = button.querySelector('svg')?.parentElement;
      expect(icon).toHaveClass('h-5', 'w-5');
      expect(button.querySelector('img')).toBeNull();
    }
  });

  describe('paging', () => {
    it('shows no pager while every Agent fits', () => {
      mockViewportWidth(900);
      renderBar(manyAgents(6), 'vendor.agent0');

      expect(
        screen.queryByRole('button', { name: '上一页 Agent' })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: '下一页 Agent' })
      ).not.toBeInTheDocument();
    });

    it('hides the left pager on the first page and the right pager on the last', async () => {
      mockViewportWidth(400);
      renderBar(manyAgents(14), 'vendor.agent0');
      const next = () => screen.queryByRole('button', { name: '下一页 Agent' });
      const previous = () =>
        screen.queryByRole('button', { name: '上一页 Agent' });

      expect(currentPage()).toBe('0');
      expect(previous()).not.toBeInTheDocument();
      expect(next()).toBeInTheDocument();

      await userEvent.click(next()!);
      expect(currentPage()).toBe('1');
      expect(previous()).toBeInTheDocument();
      expect(next()).not.toBeInTheDocument();

      await userEvent.click(previous()!);
      expect(currentPage()).toBe('0');
    });

    it('opens on the page that holds the selected Agent', () => {
      mockViewportWidth(400);
      renderBar(manyAgents(14), 'vendor.agent12');

      expect(currentPage()).toBe('1');
      expect(
        screen.queryByRole('button', { name: '下一页 Agent' })
      ).not.toBeInTheDocument();
    });

    it('keeps Agents on other pages out of keyboard and screen reader reach', () => {
      mockViewportWidth(400);
      renderBar(manyAgents(14), 'vendor.agent0');

      const pages = document.querySelectorAll('.agent-management-bar-page');
      expect(pages).toHaveLength(2);
      expect(pages[0]).not.toHaveAttribute('inert');
      expect(pages[1]).toHaveAttribute('inert');
      expect(
        within(pages[0] as HTMLElement).getAllByRole('button')
      ).toHaveLength(6);
    });

    it('follows a keyboard nudge across a page boundary', () => {
      mockViewportWidth(400);
      const onReorder = vi.fn();
      renderBar(manyAgents(14), 'vendor.agent0', { onReorder });

      fireEvent.keyDown(screen.getByRole('button', { name: 'Agent 5' }), {
        key: 'ArrowRight',
        altKey: true,
      });

      expect(onReorder).toHaveBeenCalled();
      expect(currentPage()).toBe('1');
    });

    it('keeps the actions and next-page arrow fixed in the tail outside the sliding viewport', () => {
      mockViewportWidth(400);
      renderBar(manyAgents(14), 'vendor.agent0', {
        actions: <button type="button">Add Agent</button>,
      });

      const tail = document.querySelector('.agent-management-bar-tail');
      expect(tail).toBeInTheDocument();
      expect(
        within(tail as HTMLElement).getByRole('button', { name: 'Add Agent' })
      ).toBeInTheDocument();
      expect(
        within(tail as HTMLElement).getByRole('button', {
          name: '下一页 Agent',
        })
      ).toBeInTheDocument();

      const pages = Array.from(
        document.querySelectorAll('.agent-management-bar-page')
      );
      for (const page of pages) {
        expect(
          within(page as HTMLElement).queryByRole('button', {
            name: 'Add Agent',
          })
        ).not.toBeInTheDocument();
      }
    });

    it('groups Add, Refresh, and next-page arrow into AgentBarTailGroup', () => {
      mockViewportWidth(400);
      const onAdd = vi.fn();
      const onRefresh = vi.fn();
      renderBar(manyAgents(14), 'vendor.agent0', { onAdd, onRefresh });

      const tail = document.querySelector('.agent-management-bar-tail');
      expect(tail).toBeInTheDocument();
      expect(
        within(tail as HTMLElement).getByRole('button', {
          name: '添加 Agent',
        })
      ).toBeInTheDocument();
      expect(
        within(tail as HTMLElement).getByRole('button', {
          name: '刷新 Agent 状态',
        })
      ).toBeInTheDocument();
      expect(
        within(tail as HTMLElement).getByRole('button', {
          name: '下一页 Agent',
        })
      ).toBeInTheDocument();

      fireEvent.click(
        within(tail as HTMLElement).getByRole('button', {
          name: '添加 Agent',
        })
      );
      expect(onAdd).toHaveBeenCalledTimes(1);

      fireEvent.click(
        within(tail as HTMLElement).getByRole('button', {
          name: '刷新 Agent 状态',
        })
      );
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('enforces a maximum of 10 icons per page even on wide viewports', () => {
      mockViewportWidth(900);
      renderBar(manyAgents(14), 'vendor.agent0');

      const pages = document.querySelectorAll('.agent-management-bar-page');
      expect(pages).toHaveLength(2);
      expect(
        within(pages[0] as HTMLElement).getAllByRole('button')
      ).toHaveLength(10);
      expect(
        within(pages[1] as HTMLElement).getAllByRole('button')
      ).toHaveLength(4);
    });
  });

  describe('stylesheet', () => {
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/styles/legacy/index.css'),
      'utf8'
    );
    const rules: { selector: string; decls: Record<string, string> }[] = [];
    parse(stylesheet).walkRules((rule) => {
      if (!rule.selector.includes('.agent-management')) return;
      const decls: Record<string, string> = {};
      rule.walkDecls((decl) => {
        decls[decl.prop] = decl.value;
      });
      rules.push({ selector: rule.selector, decls });
    });
    const declsFor = (selector: string) =>
      rules.find((rule) => rule.selector.includes(selector))?.decls;

    it('has no horizontal scrollbar to style or scroll', () => {
      expect(stylesheet).not.toContain('agent-management-bar-scroll');
      expect(stylesheet).not.toContain('agent-management-bar-surface');
      expect(declsFor('.agent-management-bar-viewport')?.overflow).toBe(
        'hidden'
      );
    });

    it('draws the pager arrows as bare icons without a surface', () => {
      const pagerRules = rules.filter((rule) =>
        rule.selector.includes('.agent-management-bar-pager')
      );
      expect(pagerRules.length).toBeGreaterThan(0);
      for (const rule of pagerRules) {
        expect(Object.keys(rule.decls)).not.toContain('background');
      }
    });

    it('slides pages with an eased transform', () => {
      const track = declsFor('.agent-management-bar-track');
      expect(track?.transition).toMatch(/^transform 260ms cubic-bezier/);
      expect(track?.transform).toContain('--agent-bar-page');
    });

    it('stays one compact row using pill/capsule radius for bar and items', () => {
      const bar = rules.find((rule) =>
        /\.agent-management-bar$/.test(rule.selector.trim())
      );
      expect(bar?.decls.height).toBe('calc(var(--agent-bar-item-size) + 8px)');
      expect(bar?.decls['border-radius']).toBe('9999px');
      const item = rules.find(
        (rule) =>
          /\.agent-management-bar-item$/.test(rule.selector.trim()) &&
          'border-radius' in rule.decls
      );
      expect(item?.decls['border-radius']).toBe('9999px');
    });
  });
});
