import { describe, expect, it } from 'vitest';
import { codexGoalStateFromSessionGoal } from './codexGoalState';
import {
  formatGoalDuration,
  formatGoalTokens,
  isLimitedGoalStatus,
  normalizeSessionGoalStatus,
  parseConversationSessionGoal,
  parseSessionGoalValue,
} from './sessionGoal';

describe('sessionGoal helpers', () => {
  it('normalizes camelCase limit statuses to snake_case', () => {
    expect(normalizeSessionGoalStatus('budgetLimited')).toBe('budget_limited');
    expect(normalizeSessionGoalStatus('usageLimited')).toBe('usage_limited');
    expect(normalizeSessionGoalStatus('ACTIVE')).toBe('active');
    expect(isLimitedGoalStatus('budget_limited')).toBe(true);
    expect(isLimitedGoalStatus('usage_limited')).toBe(true);
    expect(isLimitedGoalStatus('active')).toBe(false);
  });

  it('parses session goal snapshots with optional metrics and capability actions', () => {
    const parsed = parseConversationSessionGoal({
      goal: {
        objective: 'Ship Goal Bar + Async Task Bar',
        status: 'budgetLimited',
        tokensUsed: 14_200,
        tokenBudget: 20_000,
        tokensRemaining: 5_800,
        durationMs: 65_000,
      },
      actions: ['pause', 'clear'],
    });
    expect(parsed).toEqual({
      objective: 'Ship Goal Bar + Async Task Bar',
      status: 'budget_limited',
      summary: null,
      tokensUsed: 14_200,
      tokenBudget: 20_000,
      tokensRemaining: 5_800,
      durationMs: 65_000,
      updatedAt: null,
      actions: ['pause', 'clear'],
      canPause: false,
      canClear: false,
      isLiveBarVisible: false,
    });
  });

  it('returns null when goal is cleared or has no objective', () => {
    expect(parseSessionGoalValue(null)).toBeNull();
    expect(parseSessionGoalValue({ status: 'cleared' })).toBeNull();
    expect(
      parseConversationSessionGoal({
        goal: null,
        actions: ['set', 'clear'],
      })
    ).toBeNull();
  });

  it('maps ConversationSessionGoal to CodexGoalState for topbar indicator', () => {
    expect(
      codexGoalStateFromSessionGoal({
        goal: { objective: 'Refactor auth', status: 'active' },
        actions: ['pause', 'clear'],
      })
    ).toEqual({
      objective: 'Refactor auth',
      status: 'running',
    });

    expect(
      codexGoalStateFromSessionGoal({
        goal: { objective: 'Refactor auth', status: 'paused' },
        actions: ['clear'],
      })
    ).toEqual({
      objective: 'Refactor auth',
      status: 'paused',
    });

    expect(
      codexGoalStateFromSessionGoal({
        goal: { objective: 'Refactor auth', status: 'usageLimited' },
        actions: ['clear'],
      })
    ).toEqual({
      objective: 'Refactor auth',
      status: 'limited',
    });
  });

  it('formats token counts and durations', () => {
    expect(formatGoalTokens(950)).toBe('950');
    expect(formatGoalTokens(14_200)).toBe('14.2k');
    expect(formatGoalDuration(45_000)).toBe('45s');
    expect(formatGoalDuration(125_000)).toBe('2m 5s');
  });
});
