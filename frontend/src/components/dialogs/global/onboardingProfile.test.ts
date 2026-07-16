import { describe, expect, it } from 'vitest';
import type { ExecutorProfileId } from 'shared/types';
import { getOnboardingDefaultProfile } from './onboardingProfile';

describe('getOnboardingDefaultProfile', () => {
  it('keeps only the selected agent and resets legacy ACP capability choices', () => {
    const legacyProfile: ExecutorProfileId = {
      executor: 'codex',
      variant: 'GPT_5_5_APPROVALS',
      model: 'gpt-5.5',
      fast_mode: true,
      reasoning_effort: 'xhigh',
    };

    expect(getOnboardingDefaultProfile(legacyProfile)).toEqual({
      executor: 'codex',
      variant: null,
    });
  });

  it("uses Claude Code's default profile only when no agent has been selected", () => {
    expect(getOnboardingDefaultProfile(null)).toEqual({
      executor: 'claude_code',
      variant: null,
    });
  });
});
