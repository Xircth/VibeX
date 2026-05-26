import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { ExecutorProfileId } from 'shared/types';
import {
  getDefaultProfileHydrationDecision,
  getExecutorProfileAutosaveDecision,
  getScratchExecutorProfileApplication,
  getScratchProfileResetDecision,
} from './sessionComposerDraft';

export function useSessionComposerExecutorProfileHydration({
  scratchId,
  scratchExecutorProfile,
  defaultExecutorProfile,
  selectedExecutorProfile,
  setSelectedExecutorProfile,
  effectiveExecutorProfile,
  executorProfileRef,
  isScratchLoading,
  localMessage,
  saveToScratch,
}: {
  scratchId: string | undefined;
  scratchExecutorProfile: ExecutorProfileId | null;
  defaultExecutorProfile: ExecutorProfileId | null;
  selectedExecutorProfile: ExecutorProfileId | null;
  setSelectedExecutorProfile: Dispatch<
    SetStateAction<ExecutorProfileId | null>
  >;
  effectiveExecutorProfile: ExecutorProfileId | null;
  executorProfileRef: MutableRefObject<ExecutorProfileId | null>;
  isScratchLoading: boolean;
  localMessage: string;
  saveToScratch: (
    message: string,
    executorProfileId: ExecutorProfileId | null
  ) => Promise<void>;
}) {
  const previousScratchIdRef = useRef<string | undefined>(scratchId);
  const hydratedExecutorProfileScratchIdRef = useRef<string | undefined>(
    undefined
  );
  const appliedScratchExecutorProfileKeyRef = useRef<string | null>(null);
  const previousExecutorProfileKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const decision = getScratchProfileResetDecision({
      previousScratchId: previousScratchIdRef.current,
      scratchId,
      selectedExecutorProfile,
      defaultExecutorProfile,
    });
    previousScratchIdRef.current = decision.previousScratchId;
    if (decision.shouldApplySelectedExecutorProfile) {
      setSelectedExecutorProfile(decision.nextSelectedExecutorProfile);
    }
  }, [
    defaultExecutorProfile,
    scratchId,
    selectedExecutorProfile,
    setSelectedExecutorProfile,
  ]);

  useEffect(() => {
    const decision = getDefaultProfileHydrationDecision({
      isScratchLoading,
      hydratedScratchId: hydratedExecutorProfileScratchIdRef.current,
      scratchId,
      defaultExecutorProfile,
    });
    hydratedExecutorProfileScratchIdRef.current = decision.hydratedScratchId;
    if (decision.shouldApplySelectedExecutorProfile) {
      setSelectedExecutorProfile(decision.nextSelectedExecutorProfile);
    }
  }, [
    defaultExecutorProfile,
    isScratchLoading,
    scratchId,
    setSelectedExecutorProfile,
  ]);

  useEffect(() => {
    const decision = getScratchExecutorProfileApplication({
      isScratchLoading,
      scratchId,
      scratchExecutorProfile,
      appliedKey: appliedScratchExecutorProfileKeyRef.current,
      currentExecutorProfile: selectedExecutorProfile,
    });
    appliedScratchExecutorProfileKeyRef.current = decision.appliedKey;
    if (decision.nextSelectedExecutorProfile) {
      setSelectedExecutorProfile(decision.nextSelectedExecutorProfile);
    }
  }, [
    isScratchLoading,
    scratchExecutorProfile,
    scratchId,
    selectedExecutorProfile,
    setSelectedExecutorProfile,
  ]);

  useEffect(() => {
    executorProfileRef.current = effectiveExecutorProfile;
  }, [effectiveExecutorProfile, executorProfileRef]);

  useEffect(() => {
    const decision = getExecutorProfileAutosaveDecision({
      previousProfileKey: previousExecutorProfileKeyRef.current,
      executorProfile: effectiveExecutorProfile,
      isScratchLoading,
    });
    previousExecutorProfileKeyRef.current = decision.previousProfileKey;
    if (decision.shouldSaveDraft) {
      void saveToScratch(localMessage, effectiveExecutorProfile);
    }
  }, [effectiveExecutorProfile, isScratchLoading, localMessage, saveToScratch]);
}
