import { describe, expect, it } from 'vitest';
import { type ExecutorProfileId } from 'shared/types';
import { resolveResendExecutorProfile } from './ActiveExecutorProfileContext';

describe('resolveResendExecutorProfile', () => {
  it('uses the composer profile when its agent matches the session', () => {
    const active: ExecutorProfileId = {
      executor: 'codex' as const,
      variant: 'GPT_5_5',
      model: 'gpt-5.5',
      fast_mode: false,
      reasoning_effort: 'high',
    };

    expect(resolveResendExecutorProfile(active, 'codex' as const)).toEqual(
      active
    );
  });

  it('falls back to the bare session agent when no profile is published', () => {
    expect(resolveResendExecutorProfile(null, 'codex' as const)).toEqual({
      executor: 'codex' as const,
      variant: null,
    });
  });

  it('ignores a composer profile bound to a different agent', () => {
    const active: ExecutorProfileId = {
      executor: 'claude_code' as const,
      variant: 'OPUS',
    };

    expect(resolveResendExecutorProfile(active, 'codex' as const)).toEqual({
      executor: 'codex' as const,
      variant: null,
    });
  });
});
