export function getAttemptStoppedRefreshDecision({
  wasAttemptRunning,
  isAttemptRunning,
  hasWorkspace,
}: {
  wasAttemptRunning: boolean;
  isAttemptRunning: boolean;
  hasWorkspace: boolean;
}): {
  shouldRefreshBranchState: boolean;
  nextWasAttemptRunning: boolean;
} {
  return {
    shouldRefreshBranchState:
      wasAttemptRunning && !isAttemptRunning && hasWorkspace,
    nextWasAttemptRunning: isAttemptRunning,
  };
}
