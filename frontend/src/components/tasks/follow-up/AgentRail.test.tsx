import { render, screen, fireEvent, type RenderOptions } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

import { AgentRail } from './AgentRail';
import type { SelectableAgent } from '@/features/agents/useSelectableAgents';

function mockAgents(overrides?: Partial<SelectableAgent>[]): SelectableAgent[] {
  const base: SelectableAgent[] = [
    {
      agentId: 'claude_code',
      displayName: 'Claude Code',
      iconLight: null,
      iconDark: null,
      iconSvg: null,
      enabled: true,
      lifecycle: 'ready',
      runnable: true,
      settingsFeatures: [],
    },
    {
      agentId: 'codex',
      displayName: 'Codex',
      iconLight: null,
      iconDark: null,
      iconSvg: null,
      enabled: true,
      lifecycle: 'ready',
      runnable: true,
      settingsFeatures: [],
    },
    {
      agentId: 'opencode',
      displayName: 'OpenCode',
      iconLight: null,
      iconDark: null,
      iconSvg: null,
      enabled: true,
      lifecycle: 'needs_auth',
      runnable: false,
      settingsFeatures: [],
    },
  ];
  return overrides
    ? base.map((agent, i) => ({ ...agent, ...(overrides[i] ?? {}) }))
    : base;
}

function renderRail(
  ui: React.ReactNode,
  options?: RenderOptions
) {
  return render(<TooltipProvider>{ui}</TooltipProvider>, options);
}

describe('AgentRail', () => {
  it('renders nothing when profiles is null', () => {
    const { container } = renderRail(
      <AgentRail
        profiles={null}
        effectiveExecutorProfile={null}
        onChangeExecutorProfile={vi.fn()}
        selectableAgents={mockAgents()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when no agents are available', () => {
    const { container } = renderRail(
      <AgentRail
        profiles={{}}
        effectiveExecutorProfile={null}
        onChangeExecutorProfile={vi.fn()}
        selectableAgents={[]}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders one button per enabled+installed agent', () => {
    renderRail(
      <AgentRail
        profiles={{}}
        effectiveExecutorProfile={{ executor: 'claude_code', variant: null }}
        onChangeExecutorProfile={vi.fn()}
        selectableAgents={mockAgents()}
      />
    );
    const buttons = screen.getAllByRole('radio');
    expect(buttons).toHaveLength(3);
  });

  it('marks the active agent with aria-checked=true and raised-control class', () => {
    renderRail(
      <AgentRail
        profiles={{}}
        effectiveExecutorProfile={{ executor: 'claude_code', variant: null }}
        onChangeExecutorProfile={vi.fn()}
        selectableAgents={mockAgents()}
      />
    );
    const claudeButton = screen.getByLabelText('Claude Code');
    expect(claudeButton).toHaveAttribute('aria-checked', 'true');
    expect(claudeButton.className).toContain('raised-control');
    const codexButton = screen.getByLabelText('Codex');
    expect(codexButton).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onChangeExecutorProfile when an inactive agent is clicked', () => {
    const onChange = vi.fn();
    renderRail(
      <AgentRail
        profiles={{}}
        effectiveExecutorProfile={{ executor: 'claude_code', variant: null }}
        onChangeExecutorProfile={onChange}
        selectableAgents={mockAgents()}
      />
    );
    fireEvent.click(screen.getByLabelText('Codex'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      executor: 'codex',
      variant: null,
    });
  });

  it('does not call onChangeExecutorProfile for non-runnable agents', () => {
    const onChange = vi.fn();
    renderRail(
      <AgentRail
        profiles={{}}
        effectiveExecutorProfile={{ executor: 'claude_code', variant: null }}
        onChangeExecutorProfile={onChange}
        selectableAgents={mockAgents()}
      />
    );
    const openCodeButton = screen.getByLabelText('OpenCode');
    expect(openCodeButton).toBeDisabled();
    fireEvent.click(openCodeButton);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disables all buttons when disabled prop is true', () => {
    const onChange = vi.fn();
    renderRail(
      <AgentRail
        profiles={{}}
        effectiveExecutorProfile={{ executor: 'claude_code', variant: null }}
        onChangeExecutorProfile={onChange}
        disabled
        selectableAgents={mockAgents()}
      />
    );
    const buttons = screen.getAllByRole('radio');
    for (const button of buttons) {
      expect(button).toBeDisabled();
    }
  });

  it('sorts agents alphabetically by display name', () => {
    renderRail(
      <AgentRail
        profiles={{}}
        effectiveExecutorProfile={null}
        onChangeExecutorProfile={vi.fn()}
        selectableAgents={mockAgents()}
      />
    );
    const buttons = screen.getAllByRole('radio');
    expect(buttons[0]).toHaveAttribute('aria-label', 'Claude Code');
    expect(buttons[1]).toHaveAttribute('aria-label', 'Codex');
    expect(buttons[2]).toHaveAttribute('aria-label', 'OpenCode');
  });
});
