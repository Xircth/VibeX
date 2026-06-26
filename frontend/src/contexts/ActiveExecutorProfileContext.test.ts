import { describe, expect, it } from 'vitest';
import { BaseCodingAgent, type ExecutorProfileId } from 'shared/types';
import { resolveResendExecutorProfile } from './ActiveExecutorProfileContext';

describe('resolveResendExecutorProfile', () => {
  it('uses the composer profile when its agent matches the session', () => {
    const active: ExecutorProfileId = {
      executor: BaseCodingAgent.CODEX,
      variant: 'GPT_5_5',
      model: 'gpt-5.5',
      fast_mode: false,
      reasoning_effort: 'high',
    };

    expect(resolveResendExecutorProfile(active, BaseCodingAgent.CODEX)).toEqual(
      active
    );
  });

  it('falls back to the bare session agent when no profile is published', () => {
    expect(resolveResendExecutorProfile(null, BaseCodingAgent.CODEX)).toEqual({
      executor: BaseCodingAgent.CODEX,
      variant: null,
    });
  });

  it('ignores a composer profile bound to a different agent', () => {
    const active: ExecutorProfileId = {
      executor: BaseCodingAgent.CLAUDE_CODE,
      variant: 'OPUS',
    };

    expect(resolveResendExecutorProfile(active, BaseCodingAgent.CODEX)).toEqual(
      { executor: BaseCodingAgent.CODEX, variant: null }
    );
  });
});
