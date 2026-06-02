import { describe, expect, it } from 'vitest';
import {
  BaseCodingAgent,
  type DraftFollowUpData,
  type ExecutorConfigs,
  type Scratch,
} from 'shared/types';
import {
  buildDraftFollowUpScratchUpdate,
  getDefaultProfileHydrationDecision,
  getDefaultExecutorProfile,
  getDraftScratchHydrationDecision,
  getExecutorProfileAutosaveDecision,
  extractDraftFollowUpData,
  getDraftExecutorProfile,
  getScratchExecutorProfileApplication,
  getScratchProfileResetDecision,
  shouldPersistDraftFollowUp,
} from './sessionComposerDraft';

const now = '2026-05-25T00:00:00.000Z';

function scratchWithPayload(payload: Scratch['payload']): Scratch {
  return {
    id: 'scratch-1',
    payload,
    created_at: now,
    updated_at: now,
  };
}

describe('session composer draft helpers', () => {
  it('extracts DRAFT_FOLLOW_UP payloads and ignores other scratch types', () => {
    const draft: DraftFollowUpData = {
      message: 'continue',
      images: ['vibe://image-1'],
      executor_config: { executor: BaseCodingAgent.CODEX },
      queued: false,
    };

    expect(
      extractDraftFollowUpData(
        scratchWithPayload({ type: 'DRAFT_FOLLOW_UP', data: draft })
      )
    ).toBe(draft);
    expect(
      extractDraftFollowUpData(
        scratchWithPayload({ type: 'DRAFT_TASK', data: 'task draft' })
      )
    ).toBeUndefined();
    expect(extractDraftFollowUpData(null)).toBeUndefined();
  });

  it('normalizes current and legacy executor profiles from draft data', () => {
    expect(
      getDraftExecutorProfile({
        message: '',
        images: [],
        executor_config: {
          executor: BaseCodingAgent.CODEX,
          variant: 'REVIEW',
          model: 'gpt-5.4',
          fast_mode: false,
        },
        queued: false,
      })
    ).toEqual({
      executor: BaseCodingAgent.CODEX,
      variant: 'REVIEW',
      model: 'gpt-5.4',
      fast_mode: false,
      reasoning_effort: null,
    });

    expect(
      getDraftExecutorProfile({
        message: '',
        images: [],
        executor_profile_id: {
          executor: BaseCodingAgent.CLAUDE_CODE,
          variant: null,
          model_id: 'claude-model',
          fast_mode: true,
        },
      })
    ).toEqual({
      executor: BaseCodingAgent.CLAUDE_CODE,
      variant: null,
      model: 'claude-model',
      fast_mode: true,
      reasoning_effort: null,
    });

    expect(getDraftExecutorProfile(undefined)).toBeNull();
    expect(getDraftExecutorProfile({ executor_config: {} })).toBeNull();
  });

  it('skips only truly empty new drafts with default profile state', () => {
    const profile = { executor: BaseCodingAgent.CODEX };

    expect(
      shouldPersistDraftFollowUp({
        message: '   ',
        images: [],
        executorProfileId: profile,
        hasExistingScratch: false,
      })
    ).toBe(false);

    expect(
      shouldPersistDraftFollowUp({
        message: 'hello',
        images: [],
        executorProfileId: profile,
        hasExistingScratch: false,
      })
    ).toBe(true);
    expect(
      shouldPersistDraftFollowUp({
        message: '',
        images: ['vibe://image-1'],
        executorProfileId: profile,
        hasExistingScratch: false,
      })
    ).toBe(true);
    expect(
      shouldPersistDraftFollowUp({
        message: '',
        images: [],
        executorProfileId: { ...profile, variant: 'PLAN' },
        hasExistingScratch: false,
      })
    ).toBe(true);
    expect(
      shouldPersistDraftFollowUp({
        message: '',
        images: [],
        executorProfileId: profile,
        hasExistingScratch: true,
      })
    ).toBe(true);
    expect(
      shouldPersistDraftFollowUp({
        message: 'hello',
        images: [],
        executorProfileId: null,
        hasExistingScratch: true,
      })
    ).toBe(false);
  });

  it('builds the scratch update payload expected by useScratch', () => {
    const profile = {
      executor: BaseCodingAgent.CODEX,
      variant: null,
      model: 'gpt-5.4',
      fast_mode: true,
    };

    expect(
      buildDraftFollowUpScratchUpdate('continue', ['vibe://image-1'], profile)
    ).toEqual({
      payload: {
        type: 'DRAFT_FOLLOW_UP',
        data: {
          message: 'continue',
          images: ['vibe://image-1'],
          executor_config: profile,
          queued: false,
        },
      },
    });
    expect(buildDraftFollowUpScratchUpdate('continue', [], null)).toBeNull();
  });

  it('autosaves profile changes only when the key changes after loading', () => {
    const profile = {
      executor: BaseCodingAgent.CODEX,
      variant: 'PLAN',
      model: 'gpt-5.4',
      fast_mode: false,
    };

    const changed = getExecutorProfileAutosaveDecision({
      previousProfileKey: null,
      executorProfile: profile,
      isScratchLoading: false,
    });
    expect(changed).toEqual({
      previousProfileKey: 'CODEX:PLAN:gpt-5.4:false:REASONING_DEFAULT',
      shouldSaveDraft: true,
    });

    expect(
      getExecutorProfileAutosaveDecision({
        previousProfileKey: changed.previousProfileKey,
        executorProfile: { ...profile },
        isScratchLoading: false,
      })
    ).toEqual({
      previousProfileKey: changed.previousProfileKey,
      shouldSaveDraft: false,
    });

    expect(
      getExecutorProfileAutosaveDecision({
        previousProfileKey: 'CODEX:PLAN:gpt-5.4:false',
        executorProfile: { executor: BaseCodingAgent.CLAUDE_CODE },
        isScratchLoading: true,
      })
    ).toEqual({
      previousProfileKey:
        'CLAUDE_CODE:DEFAULT:DEFAULT:FAST_DEFAULT:REASONING_DEFAULT',
      shouldSaveDraft: false,
    });

    expect(
      getExecutorProfileAutosaveDecision({
        previousProfileKey:
          'CODEX:PLAN:gpt-5.4:false:REASONING_DEFAULT',
        executorProfile: { executor: BaseCodingAgent.CLAUDE_CODE },
        isScratchLoading: true,
      })
    ).toEqual({
      previousProfileKey:
        'CLAUDE_CODE:DEFAULT:DEFAULT:FAST_DEFAULT:REASONING_DEFAULT',
      shouldSaveDraft: false,
    });

    expect(
      getExecutorProfileAutosaveDecision({
        previousProfileKey:
          'CODEX:PLAN:gpt-5.4:false:REASONING_DEFAULT',
        executorProfile: null,
        isScratchLoading: false,
      })
    ).toEqual({
      previousProfileKey: null,
      shouldSaveDraft: true,
    });

    expect(
      getExecutorProfileAutosaveDecision({
        previousProfileKey: 'CODEX:PLAN:gpt-5.4:false',
        executorProfile: {
          executor: BaseCodingAgent.CODEX,
          variant: 'PLAN',
          model: 'gpt-5.4',
          fast_mode: false,
          reasoning_effort: 'low',
        } as typeof profile & { reasoning_effort: 'low' },
        isScratchLoading: false,
      })
    ).toEqual({
      previousProfileKey: 'CODEX:PLAN:gpt-5.4:false:low',
      shouldSaveDraft: true,
    });
  });

  it('decides when scratch changes should reset the selected executor profile', () => {
    const planProfile = { executor: BaseCodingAgent.CODEX, variant: 'PLAN' };
    const defaultProfile = { executor: BaseCodingAgent.CODEX, variant: null };

    expect(
      getScratchProfileResetDecision({
        previousScratchId: 'session-1',
        scratchId: 'session-2',
        selectedExecutorProfile: null,
        defaultExecutorProfile: defaultProfile,
      })
    ).toEqual({
      previousScratchId: 'session-2',
      shouldApplySelectedExecutorProfile: true,
      nextSelectedExecutorProfile: defaultProfile,
    });

    expect(
      getScratchProfileResetDecision({
        previousScratchId: 'session-1',
        scratchId: 'session-2',
        selectedExecutorProfile: planProfile,
        defaultExecutorProfile: defaultProfile,
      })
    ).toEqual({
      previousScratchId: 'session-2',
      shouldApplySelectedExecutorProfile: false,
      nextSelectedExecutorProfile: null,
    });

    expect(
      getScratchProfileResetDecision({
        previousScratchId: 'session-1',
        scratchId: 'session-1',
        selectedExecutorProfile: planProfile,
        defaultExecutorProfile: defaultProfile,
      })
    ).toEqual({
      previousScratchId: 'session-1',
      shouldApplySelectedExecutorProfile: false,
      nextSelectedExecutorProfile: null,
    });

    expect(
      getScratchProfileResetDecision({
        previousScratchId: 'session-1',
        scratchId: 'session-2',
        selectedExecutorProfile: planProfile,
        defaultExecutorProfile: null,
      })
    ).toEqual({
      previousScratchId: 'session-2',
      shouldApplySelectedExecutorProfile: true,
      nextSelectedExecutorProfile: null,
    });
  });

  it('hydrates the default profile only once per scratch id after loading', () => {
    const profile = { executor: BaseCodingAgent.CODEX };

    expect(
      getDefaultProfileHydrationDecision({
        isScratchLoading: true,
        hydratedScratchId: undefined,
        scratchId: 'session-1',
        defaultExecutorProfile: profile,
      })
    ).toEqual({
      hydratedScratchId: undefined,
      shouldApplySelectedExecutorProfile: false,
      nextSelectedExecutorProfile: null,
    });

    expect(
      getDefaultProfileHydrationDecision({
        isScratchLoading: false,
        hydratedScratchId: undefined,
        scratchId: 'session-1',
        defaultExecutorProfile: profile,
      })
    ).toEqual({
      hydratedScratchId: 'session-1',
      shouldApplySelectedExecutorProfile: true,
      nextSelectedExecutorProfile: profile,
    });

    expect(
      getDefaultProfileHydrationDecision({
        isScratchLoading: false,
        hydratedScratchId: 'session-1',
        scratchId: 'session-1',
        defaultExecutorProfile: profile,
      })
    ).toEqual({
      hydratedScratchId: 'session-1',
      shouldApplySelectedExecutorProfile: false,
      nextSelectedExecutorProfile: null,
    });

    expect(
      getDefaultProfileHydrationDecision({
        isScratchLoading: false,
        hydratedScratchId: undefined,
        scratchId: 'session-1',
        defaultExecutorProfile: null,
      })
    ).toEqual({
      hydratedScratchId: 'session-1',
      shouldApplySelectedExecutorProfile: true,
      nextSelectedExecutorProfile: null,
    });
  });

  it('hydrates draft message and images only once per scratch id after loading', () => {
    const draft: DraftFollowUpData = {
      message: 'continue from scratch',
      images: ['vibe://image-1', 'vibe://image-2'],
      executor_config: { executor: BaseCodingAgent.CODEX },
      queued: false,
    };

    expect(
      getDraftScratchHydrationDecision({
        isScratchLoading: true,
        hydratedScratchId: undefined,
        scratchId: 'session-1',
        scratchData: draft,
      })
    ).toEqual({
      hydratedScratchId: undefined,
      shouldHydrate: false,
      message: '',
      imagePaths: [],
    });

    expect(
      getDraftScratchHydrationDecision({
        isScratchLoading: false,
        hydratedScratchId: undefined,
        scratchId: 'session-1',
        scratchData: draft,
      })
    ).toEqual({
      hydratedScratchId: 'session-1',
      shouldHydrate: true,
      message: 'continue from scratch',
      imagePaths: ['vibe://image-1', 'vibe://image-2'],
    });

    expect(
      getDraftScratchHydrationDecision({
        isScratchLoading: false,
        hydratedScratchId: 'session-1',
        scratchId: 'session-1',
        scratchData: draft,
      })
    ).toEqual({
      hydratedScratchId: 'session-1',
      shouldHydrate: false,
      message: '',
      imagePaths: [],
    });

    expect(
      getDraftScratchHydrationDecision({
        isScratchLoading: false,
        hydratedScratchId: undefined,
        scratchId: 'session-2',
        scratchData: undefined,
      })
    ).toEqual({
      hydratedScratchId: 'session-2',
      shouldHydrate: true,
      message: '',
      imagePaths: [],
    });
  });

  it('applies scratch executor profiles once per scratch/profile key', () => {
    const profile = {
      executor: BaseCodingAgent.CODEX,
      variant: 'PLAN',
      model: 'gpt-5.4',
      fast_mode: false,
    };

    expect(
      getScratchExecutorProfileApplication({
        isScratchLoading: true,
        scratchId: 'session-1',
        scratchExecutorProfile: profile,
        appliedKey: null,
        currentExecutorProfile: null,
      })
    ).toEqual({
      appliedKey: null,
      nextSelectedExecutorProfile: null,
    });

    const applied = getScratchExecutorProfileApplication({
      isScratchLoading: false,
      scratchId: 'session-1',
      scratchExecutorProfile: profile,
      appliedKey: null,
      currentExecutorProfile: null,
    });
    expect(applied.nextSelectedExecutorProfile).toBe(profile);
    expect(applied.appliedKey).toContain('session-1:');

    expect(
      getScratchExecutorProfileApplication({
        isScratchLoading: false,
        scratchId: 'session-1',
        scratchExecutorProfile: profile,
        appliedKey: applied.appliedKey,
        currentExecutorProfile: null,
      })
    ).toEqual({
      appliedKey: applied.appliedKey,
      nextSelectedExecutorProfile: null,
    });

    expect(
      getScratchExecutorProfileApplication({
        isScratchLoading: false,
        scratchId: 'session-1',
        scratchExecutorProfile: profile,
        appliedKey: null,
        currentExecutorProfile: { ...profile },
      })
    ).toEqual({
      appliedKey: applied.appliedKey,
      nextSelectedExecutorProfile: null,
    });
  });

  it('selects the default executor profile from the explicit source priority', () => {
    const scratchProfile = {
      executor: BaseCodingAgent.CODEX,
      variant: 'SCRATCH',
    };
    const latestProfile = {
      executor: BaseCodingAgent.CLAUDE_CODE,
      variant: 'LATEST',
    };
    const createdProfile = {
      executor: BaseCodingAgent.OPENCODE,
      variant: 'CREATED',
    };
    const configProfile = {
      executor: BaseCodingAgent.GEMINI,
      variant: 'CONFIG',
    };
    const profiles = {
      [BaseCodingAgent.COPILOT]: { DEFAULT: {} },
      [BaseCodingAgent.DROID]: { MOBILE: {} },
    } as unknown as ExecutorConfigs['executors'];

    const baseInput = {
      scratchExecutorProfile: scratchProfile,
      latestProfileId: latestProfile,
      createdSessionProfiles: {
        'session-1': createdProfile,
      },
      sessionId: 'session-1',
      sessionExecutor: BaseCodingAgent.AMP,
      configExecutorProfile: configProfile,
      profiles,
    };

    expect(getDefaultExecutorProfile(baseInput)).toBe(scratchProfile);
    expect(
      getDefaultExecutorProfile({
        ...baseInput,
        scratchExecutorProfile: null,
      })
    ).toBe(latestProfile);
    expect(
      getDefaultExecutorProfile({
        ...baseInput,
        scratchExecutorProfile: null,
        latestProfileId: null,
      })
    ).toBe(createdProfile);
    expect(
      getDefaultExecutorProfile({
        ...baseInput,
        scratchExecutorProfile: null,
        latestProfileId: null,
        sessionId: 'unknown-session',
      })
    ).toEqual({ executor: BaseCodingAgent.AMP, variant: null });
    expect(
      getDefaultExecutorProfile({
        ...baseInput,
        scratchExecutorProfile: null,
        latestProfileId: null,
        sessionId: 'unknown-session',
        sessionExecutor: null,
      })
    ).toBe(configProfile);
    expect(
      getDefaultExecutorProfile({
        ...baseInput,
        scratchExecutorProfile: null,
        latestProfileId: null,
        sessionId: 'unknown-session',
        sessionExecutor: null,
        configExecutorProfile: null,
      })
    ).toEqual({ executor: BaseCodingAgent.COPILOT, variant: null });
    expect(
      getDefaultExecutorProfile({
        ...baseInput,
        scratchExecutorProfile: null,
        latestProfileId: null,
        sessionId: 'unknown-session',
        sessionExecutor: null,
        configExecutorProfile: null,
        profiles: null,
      })
    ).toBeNull();
  });
});
