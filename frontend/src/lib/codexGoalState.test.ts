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

  it('marks an active goal completed from Codex output', () => {
    expect(
      deriveCodexGoalState([
        { role: 'user', content: '/goal migrate settings UI' },
        { role: 'assistant', content: 'Goal completed.' },
      ])
    ).toEqual({
      objective: 'migrate settings UI',
      status: 'completed',
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

  it('captures goal details returned by the Codex goal command', () => {
    expect(
      deriveCodexGoalState([
        { role: 'user', content: '/goal' },
        {
          role: 'assistant',
          content:
            'Current goal: migrate settings UI\nStatus: paused\nToken budget: none',
        },
      ])
    ).toEqual({
      objective: 'migrate settings UI',
      status: 'paused',
    });
  });

  it('captures localized goal details returned by the Codex goal command', () => {
    expect(
      deriveCodexGoalState([
        { role: 'user', content: '/goal' },
        {
          role: 'assistant',
          content: '当前目标：修复命令菜单\n状态：运行中',
        },
      ])
    ).toEqual({
      objective: '修复命令菜单',
      status: 'running',
    });
  });
});
