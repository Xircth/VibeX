import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GoalToolCall, isGoalToolUse } from './GoalToolCall';

describe('GoalToolCall', () => {
  it('identifies goal tool calls by name or codex-goal-* id', () => {
    expect(
      isGoalToolUse({ tool_name: 'create_goal', tool_use_id: 'call-1' })
    ).toBe(true);
    expect(
      isGoalToolUse({ tool_name: 'update_goal', tool_use_id: 'call-2' })
    ).toBe(true);
    expect(
      isGoalToolUse({ tool_name: 'tool', tool_use_id: 'codex-goal-1' })
    ).toBe(true);
    expect(isGoalToolUse({ tool_name: 'Bash', tool_use_id: 'call-3' })).toBe(
      false
    );
  });

  it('renders collapsed summary and expands details with live controls', async () => {
    const onGoalControl = vi.fn().mockResolvedValue({
      action: 'pause',
      method: '_session/goal',
      should_interrupt_turn: true,
    });

    render(
      <GoalToolCall
        entry={{
          timestamp: null,
          entry_type: {
            type: 'tool_use',
            tool_name: 'create_goal',
            action_type: {
              action: 'tool',
              tool_name: 'create_goal',
              arguments: {
                objective: 'Complete end-to-end verification',
                status: 'active',
                tokensUsed: 8_400,
                tokenBudget: 20_000,
                durationMs: 30_000,
              },
              result: null,
            },
            status: { status: 'created' },
          },
          content: '',
          toolUseId: 'codex-goal-1',
        }}
        sessionGoal={{
          goal: {
            objective: 'Complete end-to-end verification',
            status: 'active',
          },
          actions: ['pause', 'clear'],
        }}
        sessionBindReady={true}
        onGoalControl={onGoalControl}
      />
    );

    const card = screen.getByTestId('goal-tool-call');
    expect(card).toBeInTheDocument();

    const summaryButton = card.querySelector('[role="button"]');
    expect(summaryButton).not.toBeNull();
    fireEvent.click(summaryButton!);

    expect(
      screen.getByText('Complete end-to-end verification')
    ).toBeInTheDocument();
    expect(screen.getByTestId('goal-tool-call-pause')).toBeInTheDocument();
    expect(screen.getByTestId('goal-tool-call-clear')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('goal-tool-call-pause'));
    await waitFor(() => {
      expect(onGoalControl).toHaveBeenCalledWith('pause');
    });
  });
});
