import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionConfigOption } from 'shared/types';
import { SessionSettingsSummary } from './SessionSettingsSummary';

const OPTIONS: AgentSessionConfigOption[] = [
  {
    key: 'model',
    label: 'Model',
    category: 'model',
    value: 'terra',
    choices: [
      { value: 'terra', label: '5.6 Terra' },
      { value: 'sol', label: '5.6 Sol' },
    ],
  },
  {
    key: 'fast_mode',
    label: 'Fast',
    value: false,
  },
  {
    key: 'reasoning_effort',
    label: '推理强度',
    category: 'thought_level',
    value: 'high',
    choices: [
      { value: 'medium', label: '中' },
      { value: 'high', label: '高' },
    ],
  },
];

const CODEX_FAST_OPTION: AgentSessionConfigOption = {
  key: 'fast-mode',
  label: 'Fast mode',
  category: 'model_config',
  value: 'off',
  choices: [
    { value: 'off', label: 'Off' },
    { value: 'on', label: 'On' },
  ],
};

describe('SessionSettingsSummary', () => {
  it('shows one mode control when Codex advertises equivalent session and config modes', async () => {
    const user = userEvent.setup();
    render(
      <SessionSettingsSummary
        sessionModes={{
          current: 'agent',
          modes: [
            { id: 'read-only', label: 'Read-only' },
            { id: 'agent', label: 'Agent' },
            { id: 'agent-full-access', label: '完全访问' },
          ],
        }}
        options={[
          {
            key: 'mode',
            label: 'Mode',
            category: 'mode',
            value: 'agent',
            choices: [
              { value: 'read-only', label: 'Read-only' },
              { value: 'agent', label: 'Agent' },
              { value: 'agent-full-access', label: '完全访问' },
            ],
          },
        ]}
        pending={{}}
        onSelectMode={vi.fn()}
        onSelectConfigOption={vi.fn()}
      />
    );

    expect(
      screen.getByRole('button', { name: '本次会话: Agent' })
    ).toBeInTheDocument();

    await user.click(screen.getByTestId('session-settings-summary'));
    expect(screen.getByText('会话模式')).toBeInTheDocument();
    expect(screen.queryByText('Mode')).not.toBeInTheDocument();
  });

  it('puts only Name and Reasoning Effort into the visible pill while keeping full settings in aria-label', () => {
    render(
      <SessionSettingsSummary
        agentIcon="claude_code"
        sessionModes={{
          current: 'plan',
          modes: [{ id: 'plan', label: 'Plan' }],
        }}
        options={[
          ...OPTIONS,
          {
            key: 'sandbox_network',
            label: 'Network',
            value: 'enabled',
            choices: [
              { value: 'disabled', label: 'Disabled' },
              { value: 'enabled', label: 'Enabled' },
            ],
          },
        ]}
        pending={{}}
        continuation={{
          policy: 'fresh',
          onChange: vi.fn(),
        }}
        onSelectMode={vi.fn()}
        onSelectConfigOption={vi.fn()}
      />
    );

    const trigger = screen.getByRole('button', {
      name: '本次会话: Plan · 5.6 Terra · 高 · Enabled · 全新上下文',
    });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent('5.6 Terra · 高');
    expect(trigger).not.toHaveTextContent('Plan');
    expect(trigger).not.toHaveTextContent('Enabled');
    expect(trigger).not.toHaveTextContent('全新上下文');
  });

  it('moves the Fast indicator onto the model or agent name without widening the summary', async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(
      <SessionSettingsSummary
        options={[OPTIONS[0], CODEX_FAST_OPTION, OPTIONS[2]]}
        pending={{ 'fast-mode': 'on' }}
        onSelectConfigOption={vi.fn()}
      />
    );

    expect(
      screen.getByRole('button', {
        name: '本次会话: 5.6 Terra · 高 · Fast',
      })
    ).toBeInTheDocument();
    expect(screen.getByText('5.6 Terra')).toHaveClass(
      'composer-fast-model-flow'
    );
    expect(screen.getByTestId('session-settings-summary')).toHaveTextContent(
      '5.6 Terra · 高'
    );
    expect(container.querySelector('.lucide-zap')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('session-settings-summary'));
    expect(screen.getByText('开启')).toHaveClass('text-primary');

    rerender(
      <SessionSettingsSummary
        agentIcon="codex"
        options={[CODEX_FAST_OPTION, OPTIONS[2]]}
        pending={{ 'fast-mode': 'on' }}
        onSelectConfigOption={vi.fn()}
      />
    );
    expect(screen.getByText('Codex')).toHaveClass('composer-fast-model-flow');
    expect(screen.getByTestId('session-settings-summary')).toHaveTextContent(
      'Codex · 高'
    );
    expect(
      screen.getByTestId('session-settings-summary')
    ).not.toHaveTextContent('Fast');
  });

  it('opens an option row into its choices and toggles Fast in place', async () => {
    const user = userEvent.setup();
    const onSelectConfigOption = vi.fn();
    render(
      <SessionSettingsSummary
        options={OPTIONS}
        pending={{}}
        onSelectConfigOption={onSelectConfigOption}
      />
    );

    await user.click(screen.getByRole('button', { name: /本次会话/ }));
    await user.click(screen.getByText('Model'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '5.6 Sol' }));
    expect(onSelectConfigOption).toHaveBeenCalledWith('model', 'sol');

    await user.click(screen.getByRole('button', { name: /本次会话/ }));
    await user.click(screen.getByText('Fast'));
    expect(onSelectConfigOption).toHaveBeenCalledWith('fast_mode', 'true');
  });

  it('toggles Codex string-valued Fast mode in place', async () => {
    const user = userEvent.setup();
    const onSelectConfigOption = vi.fn();
    render(
      <SessionSettingsSummary
        options={[OPTIONS[0], CODEX_FAST_OPTION]}
        pending={{}}
        onSelectConfigOption={onSelectConfigOption}
      />
    );

    await user.click(screen.getByRole('button', { name: /本次会话/ }));
    await user.click(screen.getByText('Fast mode'));

    expect(onSelectConfigOption).toHaveBeenCalledWith('fast-mode', 'on');
  });

  it('hides Codex collaboration mode and leaves it at the runtime default', () => {
    const onSelectConfigOption = vi.fn();
    render(
      <SessionSettingsSummary
        options={[
          {
            key: 'collaboration_mode',
            label: 'Collaboration mode',
            category: 'other',
            value: 'default',
            choices: [
              { value: 'default', label: 'Default' },
              { value: 'plan', label: 'Plan' },
            ],
          },
        ]}
        pending={{}}
        onSelectConfigOption={onSelectConfigOption}
      />
    );

    expect(
      screen.queryByTestId('session-settings-summary')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Collaboration mode')).not.toBeInTheDocument();
    expect(onSelectConfigOption).not.toHaveBeenCalled();
  });

  it('keeps advertised Max and Ultra distinct from Extra High', () => {
    render(
      <SessionSettingsSummary
        options={[
          {
            key: 'reasoning_effort',
            label: 'Reasoning effort',
            category: 'thought_level',
            value: 'ultra',
            choices: [
              { value: 'xhigh', label: 'Extra High' },
              { value: 'max', label: 'Max' },
              { value: 'ultra', label: 'Ultra' },
            ],
          },
        ]}
        pending={{}}
        onSelectConfigOption={vi.fn()}
      />
    );

    expect(screen.getByTestId('session-settings-summary')).toHaveAttribute(
      'aria-label',
      '本次会话: Ultra'
    );
  });

  it('keeps Agent-advertised default and high effort labels distinct', () => {
    render(
      <SessionSettingsSummary
        options={[
          {
            key: 'reasoning_effort',
            label: 'Reasoning effort',
            category: 'thought_level',
            value: 'default',
            choices: [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' },
              { value: 'default', label: 'Default' },
            ],
          },
        ]}
        pending={{}}
        onSelectConfigOption={vi.fn()}
      />
    );

    expect(screen.getByTestId('session-settings-summary')).toHaveAttribute(
      'aria-label',
      '本次会话: 默认'
    );
  });

  it('shows Agent full access as the compact 完全访问 label', async () => {
    const user = userEvent.setup();
    const onSelectMode = vi.fn();
    render(
      <SessionSettingsSummary
        sessionModes={{
          current: 'default',
          modes: [
            { id: 'default', label: 'Agent' },
            {
              id: 'bypassPermissions',
              label: 'Agent (Full Access)',
            },
          ],
        }}
        options={[]}
        pending={{}}
        onSelectMode={onSelectMode}
      />
    );

    await user.click(screen.getByRole('button', { name: '本次会话: Agent' }));
    await user.click(screen.getByText('会话模式'));
    fireEvent.click(screen.getByRole('menuitem', { name: '允许危险操作关闭' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '完全访问' }));

    expect(onSelectMode).toHaveBeenCalledWith('bypassPermissions');
  });

  it('keeps the closed summary compact and renders the left AgentRail only inside the expanded popover', async () => {
    const user = userEvent.setup();
    const onChangeExecutorProfile = vi.fn();
    render(
      <SessionSettingsSummary
        options={OPTIONS}
        pending={{}}
        onSelectConfigOption={vi.fn()}
        agentRail={{
          profiles: {},
          effectiveExecutorProfile: { executor: 'claude_code', variant: null },
          onChangeExecutorProfile,
          selectableAgents: [
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
          ],
        }}
      />
    );

    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('session-settings-summary'));
    expect(screen.getByRole('radiogroup', { name: '切换 Agent' })).toBeInTheDocument();
    const layeredShell = screen.getByTestId('session-settings-layered-shell');
    const railContainer = screen.getByTestId('session-settings-agent-rail');
    const detailCard = screen.getByTestId('session-settings-detail-card');
    const outerPopover = layeredShell.closest('[data-floating-layer="popover"]');
    expect(outerPopover).toHaveClass(
      'rounded-lg',
      'border',
      'border-border/80',
      'bg-popover'
    );
    expect(outerPopover).not.toHaveClass('border-2');
    expect(layeredShell).toHaveClass('flex', 'min-h-[11rem]', 'items-stretch', 'p-1');
    expect(railContainer).toHaveClass(
      'absolute',
      'inset-0',
      'overflow-y-auto',
      '[scrollbar-width:none]',
      '[&::-webkit-scrollbar]:hidden',
      'bg-popover'
    );
    expect(railContainer).not.toHaveClass('bg-[var(--surface-sidebar)]');
    expect(detailCard).toHaveClass('min-h-[10.5rem]', 'bg-popover', 'p-1');
    expect(detailCard).not.toHaveClass('border');
    expect(detailCard).not.toHaveClass('border-border/80');
    expect(within(detailCard).queryByText('Claude Code')).not.toBeInTheDocument();
    expect(within(detailCard).queryByText('本次会话')).not.toBeInTheDocument();
    expect(within(detailCard).getByText('Model')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(onChangeExecutorProfile).toHaveBeenCalledWith({
      executor: 'codex',
      variant: null,
    });
    expect(screen.getByRole('radiogroup', { name: '切换 Agent' })).toBeInTheDocument();
  });

  it('stays mounted with the selected agent name when an agent advertises no session options and supports continuation policy', async () => {
    const user = userEvent.setup();
    const onContinuationChange = vi.fn();
    const { rerender } = render(
      <SessionSettingsSummary
        options={[]}
        pending={{}}
        agentRail={{
          profiles: {},
          effectiveExecutorProfile: { executor: 'codex', variant: null },
          onChangeExecutorProfile: vi.fn(),
          selectableAgents: [
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
          ],
        }}
        continuation={{
          policy: 'portable',
          onChange: onContinuationChange,
        }}
      />
    );

    expect(
      screen.getByRole('button', { name: '本次会话: Codex' })
    ).toBeInTheDocument();

    await user.click(screen.getByTestId('session-settings-summary'));
    expect(screen.getByText('使用默认配置')).toBeInTheDocument();
    await user.click(screen.getByText('下一条输入的上下文'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '全新上下文' }));
    expect(onContinuationChange).toHaveBeenCalledWith('fresh');

    rerender(
      <SessionSettingsSummary
        options={[]}
        pending={{}}
        agentRail={{
          profiles: {},
          effectiveExecutorProfile: { executor: 'codex', variant: null },
          onChangeExecutorProfile: vi.fn(),
          selectableAgents: [
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
          ],
        }}
        continuation={{
          policy: 'fresh',
          onChange: onContinuationChange,
        }}
      />
    );

    const updatedTrigger = screen.getByRole('button', {
      name: '本次会话: 全新上下文',
    });
    expect(updatedTrigger).toHaveTextContent('Codex');
    expect(updatedTrigger).not.toHaveTextContent('全新上下文');
  });

  it('renders a raised summary trigger and keeps Agent switching enabled even when persona metadata is present', async () => {
    const user = userEvent.setup();
    const onChangeExecutorProfile = vi.fn();

    render(
      <SessionSettingsSummary
        options={OPTIONS}
        pending={{}}
        onSelectConfigOption={vi.fn()}
        dropdownAlign="end"
        persona={{
          name: '架构师小A',
          agentName: 'claude_code',
        }}
        agentRail={{
          profiles: {},
          effectiveExecutorProfile: {
            executor: 'CLAUDE_CODE' as never,
            variant: null,
          },
          onChangeExecutorProfile,
          selectableAgents: [
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
          ],
        }}
      />
    );

    const trigger = screen.getByTestId('session-settings-summary');
    expect(trigger).toHaveClass('raised-control');
    expect(trigger).toHaveAttribute('data-raised-selector');
    expect(trigger).not.toHaveClass('rounded-full');

    await user.click(trigger);

    const rail = screen.getByRole('radiogroup');
    expect(
      within(rail).getByRole('radio', { name: 'Claude Code' })
    ).toHaveAttribute('aria-checked', 'true');

    await user.click(within(rail).getByRole('radio', { name: 'Codex' }));
    expect(onChangeExecutorProfile).toHaveBeenCalledWith({
      executor: 'codex',
      variant: null,
    });
  });

  it('stays mounted when the only advertised control is an off boolean toggle', async () => {
    const user = userEvent.setup();
    const onSelectConfigOption = vi.fn();

    render(
      <SessionSettingsSummary
        options={[
          {
            key: 'fast_mode',
            label: 'Fast',
            value: false,
          },
        ]}
        pending={{}}
        onSelectConfigOption={onSelectConfigOption}
      />
    );

    const trigger = screen.getByTestId('session-settings-summary');
    expect(trigger).toBeInTheDocument();

    await user.click(trigger);
    await user.click(screen.getByText('Fast'));
    expect(onSelectConfigOption).toHaveBeenCalledWith('fast_mode', 'true');
  });
});
