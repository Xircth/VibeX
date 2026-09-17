/**
 * ADR-0081 D5: skip waiting on conversation detail only when a Built-in
 * Profile has already declared it cannot resume and cannot load.
 * Unknown / missing capabilities must wait until detail succeeds.
 * Never key this off a hardcoded agent_id.
 */
export function canSkipInFlightHistoryWait(
  capabilities?: {
    resume_session?: boolean | null;
    load_session?: boolean | null;
  } | null
): boolean {
  return (
    capabilities?.resume_session === false &&
    capabilities?.load_session === false
  );
}
