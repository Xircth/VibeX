import { fireEvent, render, screen } from '@testing-library/react';
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

describe('SessionSettingsSummary', () => {
  it('puts the selected session values into one readable trigger', () => {
    render(
      <SessionSettingsSummary
        sessionModes={{
          current: 'plan',
          modes: [{ id: 'plan', label: 'Plan' }],
        }}
        options={OPTIONS}
        pending={{}}
        onSelectMode={vi.fn()}
        onSelectConfigOption={vi.fn()}
      />
    );

    expect(
      screen.getByRole('button', {
        name: '本次会话: Plan · 5.6 Terra · 高',
      })
    ).toBeInTheDocument();
  });

  it('moves the Fast indicator onto the model name without widening the summary', () => {
    const { container } = render(
      <SessionSettingsSummary
        options={OPTIONS}
        pending={{ fast_mode: 'true' }}
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
});
