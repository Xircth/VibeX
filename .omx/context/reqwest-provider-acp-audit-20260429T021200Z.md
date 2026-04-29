# Ralph Context Snapshot

Timestamp: 2026-04-29T02:12:00Z

## Task Statement

Fix the desktop-app crash `reqwest ... No provider set` and check whether the
ACP migration is fully complete.

## Desired Outcome

- `vibex` no longer panics during startup because `reqwest`/`rustls` has a
  crypto provider installed before any TLS client is constructed.
- ACP migration status is verified against the existing PRD/test spec, with
  any remaining gaps identified precisely.

## Known Facts / Evidence

- The crash occurs in `reqwest 0.12.28` with `No provider set`.
- Workspace `Cargo.toml` configures `reqwest` with
  `rustls-tls-webpki-roots-no-provider`, which requires explicit runtime
  provider installation.
- `src-tauri/src/lib.rs` starts `preview_proxy::ensure_started()` during app
  setup, and `src-tauri/src/preview_proxy.rs` builds a `reqwest::Client`.
- `crates/review/src/main.rs` already fixes the same class of issue by calling
  `rustls::crypto::aws_lc_rs::default_provider().install_default()` before any
  TLS work.
- ACP migration planning artifacts already exist:
  `.omx/plans/prd-acp-agent-migration.md` and
  `.omx/plans/test-spec-acp-agent-migration.md`.
- ACP provider code currently lives in
  `crates/executors/src/executors/acp/provider.rs`.

## Constraints

- Do not revert unrelated user changes in the dirty worktree.
- Keep diffs small and reversible.
- Verify with build/search evidence before claiming ACP migration complete.

## Unknowns / Open Questions

- Whether any production code paths still depend on removed legacy Codex,
  Claude, or OpenCode transports.
- Whether additional runtime entrypoints besides `vibex` also need explicit
  rustls provider installation.

## Likely Touchpoints

- `src-tauri/src/lib.rs`
- `src-tauri/src/preview_proxy.rs`
- `Cargo.toml`
- `crates/executors/src/executors/acp/provider.rs`
- `crates/executors/src/executors/{codex,claude,opencode,mod}.rs`
- `src-tauri/src/commands/agent_settings.rs`
