# RB-001 Log Replay Normalization Target Cleanup Plan

Scope: historical/raw log replay normalization target selection in `crates/services/src/services/container.rs`.

## Problem

`stream_raw_logs_to_db` repeats action-type normalization logic that now exists in `container_workflow::log_normalization_target`. The repeated branch is not just noisy: its review-action branch uses the workspace root instead of `ReviewRequest::effective_dir`, while the live start path uses the action's effective working directory. A review action with `working_dir` can therefore normalize live logs and replayed logs from different directories.

## Behavior Lock

- Raw-log replay and live startup use the same normalization-target policy.
- Coding-agent initial, follow-up, and review actions normalize from their effective working directory.
- Script actions still do not normalize.

## Cleanup

- Reuse `container_workflow::log_normalization_target` in `stream_raw_logs_to_db`.
- Keep msg-store construction, `ensure_container_exists`, executor lookup, QA-mode branches, and stream filtering in `stream_raw_logs_to_db`.
- Preserve the existing replay fallback to `get_coding_agent_or_default` for missing profiles.

## Verification

- `cargo test -p services container_workflow --lib`
- `cargo check -p services -p local-deployment`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
