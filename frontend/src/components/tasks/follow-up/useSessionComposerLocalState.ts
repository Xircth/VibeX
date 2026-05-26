import { useMemo, useRef, useState } from 'react';
import type { ExecutorProfileId } from 'shared/types';
import type { SessionComposerImage } from './SessionComposerInput';

export function useSessionComposerLocalState() {
  const [localMessage, setLocalMessage] = useState('');
  const [attachedImages, setAttachedImages] = useState<SessionComposerImage[]>(
    []
  );
  const attachedImagePaths = useMemo(
    () => attachedImages.map((image) => image.path),
    [attachedImages]
  );
  const executorProfileRef = useRef<ExecutorProfileId | null>(null);

  return {
    localMessage,
    setLocalMessage,
    attachedImages,
    setAttachedImages,
    attachedImagePaths,
    executorProfileRef,
  };
}

export function useSessionComposerProfileSelection(
  defaultExecutorProfile: ExecutorProfileId | null
) {
  const [selectedExecutorProfile, setSelectedExecutorProfile] =
    useState<ExecutorProfileId | null>(defaultExecutorProfile);
  const effectiveExecutorProfile =
    selectedExecutorProfile ?? defaultExecutorProfile;

  return {
    selectedExecutorProfile,
    setSelectedExecutorProfile,
    effectiveExecutorProfile,
  };
}
