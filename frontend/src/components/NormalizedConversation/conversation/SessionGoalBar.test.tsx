import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionGoalBar } from './SessionGoalBar';

describe('SessionGoalBar', () => {
  it('does not mount when sessionGoal is null or completed', () => {
    const { container, rerender } = render(
      <SessionGoalBar sessionGoal={null} sessionBindReady={true} />
    );
    expect(container).toBeEmptyDOMElement();

    rerender(
      <SessionGoalBar
        sessionGoal={{
          goal: { objective: 'Done objective', status: 'completed' },
          actions: ['clear'],
        }}
        sessionBindReady={true}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders active goal with pause and clear buttons for Codex capability matrix', async () => {
    const onGoalControl = vi.fn().mockResolvedValue({
      action: 'pause',
      method: '_session/goal',
      should_interrupt_turn: true,
    });
    const onSelectGoal = vi.fn();

    render(
      <SessionGoalBar
        sessionGoal={{
          goal: {
            objective: 'Implement sticky goal bar',
            status: 'active',
            tokensUsed: 12_500,
            durationMs: 42_000,
          },
          actions: ['pause', 'clear'],
        }}
        sessionBindReady={true}
        onGoalControl={onGoalControl}
        onSelectGoal={onSelectGoal}
      />
    );

    expect(screen.getByTestId('session-goal-bar')).toBeInTheDocument();
    expect(screen.getByText('Implement sticky goal bar')).toBeInTheDocument();
    expect(screen.getByText(/12\.5k/)).toBeInTheDocument();
    expect(screen.getByText(/42s/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Implement sticky goal bar'));
    expect(onSelectGoal).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('session-goal-pause'));
    await waitFor(() => {
      expect(onGoalControl).toHaveBeenCalledWith('pause');
    });

    fireEvent.click(screen.getByTestId('session-goal-clear'));
    await waitFor(() => {
      expect(onGoalControl).toHaveBeenCalledWith('clear');
    });
  });

  it('hides pause button for Claude capability matrix (set + clear only)', () => {
    render(
      <SessionGoalBar
        sessionGoal={{
          goal: {
            objective: 'Claude goal without pause',
            status: 'active',
          },
          actions: ['set', 'clear'],
        }}
        sessionBindReady={true}
        onGoalControl={vi.fn()}
      />
    );

    expect(screen.queryByTestId('session-goal-pause')).not.toBeInTheDocument();
    expect(screen.getByTestId('session-goal-clear')).toBeInTheDocument();
  });

  it('hides action buttons when actions is null (before initialize) or empty []', () => {
    const { rerender } = render(
      <SessionGoalBar
        sessionGoal={{
          goal: { objective: 'Before initialize', status: 'active' },
          actions: null,
        }}
        sessionBindReady={true}
        onGoalControl={vi.fn()}
      />
    );

    expect(screen.queryByTestId('session-goal-pause')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-goal-clear')).not.toBeInTheDocument();

    rerender(
      <SessionGoalBar
        sessionGoal={{
          goal: { objective: 'Read-only advertised', status: 'active' },
          actions: [],
        }}
        sessionBindReady={true}
        onGoalControl={vi.fn()}
      />
    );

    expect(screen.queryByTestId('session-goal-pause')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-goal-clear')).not.toBeInTheDocument();
  });

  it('renders fallbackGoal above the composer when ACP sessionGoal is null', () => {
    render(
      <SessionGoalBar
        sessionGoal={null}
        fallbackGoal={{
          objective: '分析当前项目并给出优化建议',
          status: 'running',
        }}
        sessionBindReady={true}
      />
    );

    expect(screen.getByTestId('session-goal-bar')).toHaveAttribute(
      'data-goal-status',
      'active'
    );
    expect(screen.getByText('分析当前项目并给出优化建议')).toBeInTheDocument();
  });
});
