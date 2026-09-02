import { describe, expect, it } from 'vitest';
import {
  normalizeInvocationQuery,
  rankByTextMatch,
  scoreTextMatch,
} from './textMatch';

describe('textMatch', () => {
  it('strips / and $ trigger prefixes from invocation queries', () => {
    expect(normalizeInvocationQuery('/$deploy')).toBe('deploy');
    expect(normalizeInvocationQuery('$plan')).toBe('plan');
    expect(normalizeInvocationQuery('  /compact ')).toBe('compact');
  });

  it('ranks exact, prefix, substring, then subsequence matches', () => {
    const cmds = [
      { name: 'bmad-help' },
      { name: 'help' },
      { name: 'browser-use' },
    ];
    expect(rankByTextMatch('bmadhelp', cmds, (cmd) => cmd.name)[0]?.name).toBe(
      'bmad-help'
    );
    expect(rankByTextMatch('bmhp', cmds, (cmd) => cmd.name)[0]?.name).toBe(
      'bmad-help'
    );
    expect(rankByTextMatch('help', cmds, (cmd) => cmd.name)[0]?.name).toBe(
      'help'
    );
  });

  it('does not score an empty query', () => {
    expect(scoreTextMatch('', 'deploy')).toBeNull();
  });
});
