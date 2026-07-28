import type {
  AgentKind,
  DraftFollowUpData,
  ExecutorConfigs,
  ExecutorProfileId,
  Scratch,
  UpdateScratch,
} from 'shared/types';
import { getFirstAvailableProfile } from '@/utils/executor';

type LegacyExecutorProfile = Partial<ExecutorProfileId> & {
  model_id?: unknown;
  executor?: unknown;
  variant?: unknown;
  model?: unknown;
  fast_mode?: unknown;
  reasoning_effort?: unknown;
  reasoning_id?: unknown;
};

type LegacyDraftFollowUpData = Omit<
  Partial<DraftFollowUpData>,
  'executor_config'
> & {
  executor_profile_id?: LegacyExecutorProfile;
  executor_config?: LegacyExecutorProfile;
};

export function extractDraftFollowUpData(
  scratch: Scratch | null | undefined
): DraftFollowUpData | undefined {
  return scratch?.payload?.type === 'DRAFT_FOLLOW_UP'
    ? scratch.payload.data
    : undefined;
}

export function getDraftExecutorProfile(
  data: LegacyDraftFollowUpData | undefined
): ExecutorProfileId | null {
  const raw = data?.executor_config ?? data?.executor_profile_id;
  if (typeof raw?.executor !== 'string') return null;

  const model =
    typeof raw.model === 'string'
      ? raw.model
      : typeof raw.model_id === 'string'
        ? raw.model_id
        : null;
  const fastMode = typeof raw.fast_mode === 'boolean' ? raw.fast_mode : null;
  const variant = typeof raw.variant === 'string' ? raw.variant : null;
  const reasoningEffort =
    typeof raw.reasoning_effort === 'string'
      ? raw.reasoning_effort
      : typeof raw.reasoning_id === 'string'
        ? raw.reasoning_id
        : null;

  return {
    executor: raw.executor as ExecutorProfileId['executor'],
    variant,
    model,
    fast_mode: fastMode,
    reasoning_effort: reasoningEffort,
  };
}

export function getDefaultExecutorProfile({
  scratchExecutorProfile,
  latestProfileId,
  createdSessionProfiles,
  sessionId,
  sessionExecutor,
  configExecutorProfile,
  profiles,
}: {
  scratchExecutorProfile: ExecutorProfileId | null;
  latestProfileId: ExecutorProfileId | null;
  createdSessionProfiles: Record<string, ExecutorProfileId | undefined>;
  sessionId: string | null | undefined;
  sessionExecutor: AgentKind | null | undefined;
  configExecutorProfile: ExecutorProfileId | null | undefined;
  profiles: ExecutorConfigs['executors'] | null | undefined;
}): ExecutorProfileId | null {
  if (scratchExecutorProfile) return scratchExecutorProfile;
  if (latestProfileId) return latestProfileId;

  const createdSessionProfile = sessionId
    ? createdSessionProfiles[sessionId]
    : null;
  if (createdSessionProfile?.executor) return createdSessionProfile;

  if (sessionExecutor) {
    return { executor: sessionExecutor, variant: null };
  }

  if (configExecutorProfile) return configExecutorProfile;

  return getFirstAvailableProfile(profiles);
}

export function shouldPersistDraftFollowUp({
  message,
  images,
  executorProfileId,
  hasExistingScratch,
}: {
  message: string;
  images: string[];
  executorProfileId: ExecutorProfileId | null;
  hasExistingScratch: boolean;
}): boolean {
  if (!executorProfileId?.executor) return false;
  return Boolean(
    message.trim() ||
      images.length > 0 ||
      executorProfileId.variant ||
      executorProfileId.model ||
      executorProfileId.fast_mode != null ||
      executorProfileId.reasoning_effort ||
      hasExistingScratch
  );
}

export function buildDraftFollowUpScratchUpdate(
  message: string,
  images: string[],
  executorProfileId: ExecutorProfileId | null,
  existingSessionControls?: Pick<
    DraftFollowUpData,
    'mode_override' | 'config_overrides'
  >
): UpdateScratch | null {
  if (!executorProfileId?.executor) return null;

  return {
    payload: {
      type: 'DRAFT_FOLLOW_UP',
      data: {
        message,
        images,
        executor_config: executorProfileId,
        queued: false,
        ...(existingSessionControls?.mode_override
          ? { mode_override: existingSessionControls.mode_override }
          : {}),
        config_overrides: compactConfigOverrides(
          existingSessionControls?.config_overrides
        ),
      },
    },
  };
}

export function getExecutorProfileStateKey(
  profile: ExecutorProfileId | null
): string | null {
  if (!profile?.executor) return null;
  return [
    profile.executor,
    profile.variant ?? 'DEFAULT',
    profile.model ?? 'DEFAULT',
    profile.fast_mode == null ? 'FAST_DEFAULT' : String(profile.fast_mode),
    profile.reasoning_effort ?? 'REASONING_DEFAULT',
  ].join(':');
}

export function getExecutorProfileAutosaveDecision({
  previousProfileKey,
  executorProfile,
  isScratchLoading,
}: {
  previousProfileKey: string | null;
  executorProfile: ExecutorProfileId | null;
  isScratchLoading: boolean;
}): {
  previousProfileKey: string | null;
  shouldSaveDraft: boolean;
} {
  const profileKey = getExecutorProfileStateKey(executorProfile);
  if (previousProfileKey === profileKey) {
    return {
      previousProfileKey,
      shouldSaveDraft: false,
    };
  }

  return {
    previousProfileKey: profileKey,
    shouldSaveDraft: !isScratchLoading,
  };
}

export function getScratchProfileResetDecision({
  previousScratchId,
  scratchId,
  selectedExecutorProfile,
  defaultExecutorProfile,
}: {
  previousScratchId: string | undefined;
  scratchId: string | undefined;
  selectedExecutorProfile: ExecutorProfileId | null;
  defaultExecutorProfile: ExecutorProfileId | null;
}): {
  previousScratchId: string | undefined;
  shouldApplySelectedExecutorProfile: boolean;
  nextSelectedExecutorProfile: ExecutorProfileId | null;
} {
  const scratchChanged = previousScratchId !== scratchId;
  if (!scratchChanged && selectedExecutorProfile) {
    return {
      previousScratchId: scratchId,
      shouldApplySelectedExecutorProfile: false,
      nextSelectedExecutorProfile: null,
    };
  }

  const shouldPreserveSelectedVariant =
    scratchChanged &&
    !!selectedExecutorProfile &&
    !!defaultExecutorProfile &&
    selectedExecutorProfile.executor === defaultExecutorProfile.executor &&
    !!selectedExecutorProfile.variant &&
    !defaultExecutorProfile.variant;

  return {
    previousScratchId: scratchId,
    shouldApplySelectedExecutorProfile: !shouldPreserveSelectedVariant,
    nextSelectedExecutorProfile: shouldPreserveSelectedVariant
      ? null
      : defaultExecutorProfile,
  };
}

export function getDefaultProfileHydrationDecision({
  isScratchLoading,
  hydratedScratchId,
  scratchId,
  defaultExecutorProfile,
}: {
  isScratchLoading: boolean;
  hydratedScratchId: string | undefined;
  scratchId: string | undefined;
  defaultExecutorProfile: ExecutorProfileId | null;
}): {
  hydratedScratchId: string | undefined;
  shouldApplySelectedExecutorProfile: boolean;
  nextSelectedExecutorProfile: ExecutorProfileId | null;
} {
  if (isScratchLoading || hydratedScratchId === scratchId) {
    return {
      hydratedScratchId,
      shouldApplySelectedExecutorProfile: false,
      nextSelectedExecutorProfile: null,
    };
  }

  return {
    hydratedScratchId: scratchId,
    shouldApplySelectedExecutorProfile: true,
    nextSelectedExecutorProfile: defaultExecutorProfile,
  };
}

export function getDraftScratchHydrationDecision({
  isScratchLoading,
  hydratedScratchId,
  scratchId,
  scratchData,
}: {
  isScratchLoading: boolean;
  hydratedScratchId: string | undefined;
  scratchId: string | undefined;
  scratchData: DraftFollowUpData | undefined;
}): {
  hydratedScratchId: string | undefined;
  shouldHydrate: boolean;
  message: string;
  imagePaths: string[];
  modeOverride: string | null;
  configOverrides: Record<string, string>;
} {
  if (isScratchLoading || hydratedScratchId === scratchId) {
    return {
      hydratedScratchId,
      shouldHydrate: false,
      message: '',
      imagePaths: [],
      modeOverride: null,
      configOverrides: {},
    };
  }

  return {
    hydratedScratchId: scratchId,
    shouldHydrate: true,
    message: scratchData?.message ?? '',
    imagePaths: [...(scratchData?.images ?? [])],
    // Create-form session-control presets ride the draft into the composer's
    // pending state and go out as the first turn's overrides.
    modeOverride: scratchData?.mode_override ?? null,
    configOverrides: compactConfigOverrides(scratchData?.config_overrides),
  };
}

/** ts-rs exports the BTreeMap as a partial record; drop undefined slots. */
function compactConfigOverrides(
  raw: DraftFollowUpData['config_overrides'] | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export function getScratchExecutorProfileApplication({
  isScratchLoading,
  scratchId,
  scratchExecutorProfile,
  appliedKey,
  currentExecutorProfile,
}: {
  isScratchLoading: boolean;
  scratchId: string | undefined;
  scratchExecutorProfile: ExecutorProfileId | null;
  appliedKey: string | null;
  currentExecutorProfile: ExecutorProfileId | null;
}): {
  appliedKey: string | null;
  nextSelectedExecutorProfile: ExecutorProfileId | null;
} {
  if (isScratchLoading || !scratchExecutorProfile) {
    return { appliedKey, nextSelectedExecutorProfile: null };
  }

  const scratchProfileKey = getExecutorProfileStateKey(scratchExecutorProfile);
  const nextAppliedKey = `${scratchId ?? ''}:${scratchProfileKey ?? ''}`;
  if (appliedKey === nextAppliedKey) {
    return { appliedKey, nextSelectedExecutorProfile: null };
  }

  if (
    getExecutorProfileStateKey(currentExecutorProfile) === scratchProfileKey
  ) {
    return { appliedKey: nextAppliedKey, nextSelectedExecutorProfile: null };
  }

  return {
    appliedKey: nextAppliedKey,
    nextSelectedExecutorProfile: scratchExecutorProfile,
  };
}
