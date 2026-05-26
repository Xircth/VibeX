import { useEffect, useRef } from 'react';
import { getAttemptStoppedRefreshDecision } from './sessionComposerAttempt';

export function useSessionComposerAttemptRefresh({
  isAttemptRunning,
  workspaceId,
  refetchBranchStatus,
  refetchAttemptBranch,
}: {
  isAttemptRunning: boolean;
  workspaceId: string | null | undefined;
  refetchBranchStatus: () => void;
  refetchAttemptBranch: () => void;
}) {
  const prevRunningRef = useRef<boolean>(isAttemptRunning);

  useEffect(() => {
    const decision = getAttemptStoppedRefreshDecision({
      wasAttemptRunning: prevRunningRef.current,
      isAttemptRunning,
      hasWorkspace: Boolean(workspaceId),
    });

    if (decision.shouldRefreshBranchState) {
      refetchBranchStatus();
      refetchAttemptBranch();
    }
    prevRunningRef.current = decision.nextWasAttemptRunning;
  }, [
    isAttemptRunning,
    workspaceId,
    refetchBranchStatus,
    refetchAttemptBranch,
  ]);
}
