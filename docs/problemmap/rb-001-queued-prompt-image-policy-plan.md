# RB-001 Queued Prompt Image Policy Cleanup Plan

Scope: `crates/local-deployment/src/container.rs` queued follow-up prompt construction.

## Problem

`start_queued_follow_up` depends on a pure prompt-building rule that formats queued image paths as Markdown and appends them to the message. That rule currently lives as a free helper in `container.rs`, keeping presentation-like string policy in the local runtime service file.

## Behavior Lock

- No images returns the original message unchanged.
- Blank image paths are ignored after trimming.
- Non-empty messages get two newlines before image Markdown.
- Blank messages return only image Markdown.
- Image paths are trimmed before formatting as `![](path)`.

## Cleanup

- Move the prompt/image composition helper into `process_completion`.
- Keep queued-message DB/session validation and action construction in `LocalContainerService::start_queued_follow_up`.
- Do not change executor action selection or cleanup-action chaining.

## Verification

- `cargo test -p local-deployment process_completion --lib`
- `cargo check -p local-deployment`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
