import { describe, expect, it } from 'vitest';
import { deriveCodexGoalState } from './codexGoalState';

describe('deriveCodexGoalState', () => {
  it('tracks a goal created by slash command', () => {
    expect(
      deriveCodexGoalState([
        { role: 'user', content: '/goal migrate settings UI' },
      ])
    ).toEqual({
      objective: 'migrate settings UI',
      status: 'running',
    });
  });

  it('tracks pause and resume subcommands', () => {
    expect(
      deriveCodexGoalState([
        { role: 'user', content: '/goal migrate settings UI' },
        { role: 'user', content: '/goal pause' },
        { role: 'user', content: '/goal resume' },
      ])
    ).toEqual({
      objective: 'migrate settings UI',
      status: 'running',
    });
  });

  it('does not infer status from assistant free text', () => {
    expect(
      deriveCodexGoalState([
        { role: 'user', content: '/goal migrate settings UI' },
        { role: 'assistant', content: 'Goal completed.' },
      ])
    ).toEqual({
      objective: 'migrate settings UI',
      status: 'running',
    });
  });

  it('clears goal state when requested', () => {
    expect(
      deriveCodexGoalState([
        { role: 'user', content: '/goal migrate settings UI' },
        { role: 'user', content: '/goal clear' },
      ])
    ).toBeNull();
  });

  it('marks complete only from an explicit user command', () => {
    expect(
      deriveCodexGoalState([
        { role: 'user', content: '/goal migrate settings UI' },
        { role: 'user', content: '/goal complete' },
      ])
    ).toEqual({
      objective: 'migrate settings UI',
      status: 'completed',
    });
  });
});
