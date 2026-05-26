import { useCallback, useRef, type RefObject } from 'react';
import type { ExecutorProfileId } from 'shared/types';
import {
  getComposerSessionSelectionNotification,
  getCreatedSessionProfileMemoryUpdate,
} from './sessionComposerSession';

type ComposerSessionEvent = {
  sessionId: string;
  workspaceId: string;
};

export function useSessionComposerSessionCallbacks({
  workspaceId,
  selectSession,
  onSessionSelected,
  onSessionCreated,
  executorProfileRef,
}: {
  workspaceId: string | null | undefined;
  selectSession: (sessionId: string) => void;
  onSessionSelected?: (session: ComposerSessionEvent) => void;
  onSessionCreated?: (session: ComposerSessionEvent) => void;
  executorProfileRef: RefObject<ExecutorProfileId | null>;
}) {
  const createdSessionProfilesRef = useRef<
    Record<string, ExecutorProfileId | undefined>
  >({});

  const handleSelectSession = useCallback(
    (nextSessionId: string) => {
      selectSession(nextSessionId);
      const notification = getComposerSessionSelectionNotification({
        sessionId: nextSessionId,
        workspaceId,
      });
      if (notification) onSessionSelected?.(notification);
    },
    [onSessionSelected, selectSession, workspaceId]
  );

  const handleSessionCreated = useCallback(
    (createdSession: ComposerSessionEvent) => {
      const memoryUpdate = getCreatedSessionProfileMemoryUpdate({
        sessionId: createdSession.sessionId,
        profile: executorProfileRef.current,
      });
      if (memoryUpdate) {
        createdSessionProfilesRef.current[memoryUpdate.sessionId] =
          memoryUpdate.profile;
      }
      onSessionCreated?.(createdSession);
    },
    [executorProfileRef, onSessionCreated]
  );

  return {
    createdSessionProfiles: createdSessionProfilesRef.current,
    handleSelectSession,
    handleSessionCreated,
  };
}
