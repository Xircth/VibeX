# TAURI-004 Provider Runtime Module Cleanup Plan

Scope: `src-tauri/src/commands/provider_runtime/mod.rs` and its included
provider runtime shards.

## Problem

`provider_runtime/mod.rs` still composes most runtime implementation files with
textual `include!`. This keeps provider event parsing, token accounting, SDK
bridges, native conversation state, Codex app-server control, command handlers,
and history loading in one implicit namespace.

## Behavior Lock

- `cargo test -p vibex provider_runtime --lib`
- After each slice: `cargo check -p vibex`, `pnpm run check`, and
  `pnpm run lint`.

## First Slice

Convert `token_usage.rs` to a real module:

- add explicit imports for `serde_json::Value`, `TokenUsageInfo`, and provider
  diagnostic text extraction;
- expose only token usage/error extraction entry points needed by sibling
  runtime shards as `pub(super)`;
- re-export those entry points from `mod.rs` at parent visibility so existing
  included shards and tests keep the same call surface;
- keep token usage parsing and provider error extraction behavior unchanged.

## Second Slice

Convert `provider_text.rs` to a real module:

- add explicit imports for provider request/event types, JSON helpers, path
  types, native conversation/log state, DB log persistence, deployment/container
  access, and async synchronization;
- expose only helper functions currently used by sibling runtime shards/tests as
  `pub(super)`;
- keep recursive text extraction helpers private when they are only used inside
  the text module;
- keep provider text extraction, Codex ID/status extraction, native log pushing,
  and provider event history behavior unchanged.

## Third Slice

Convert `opencode_sdk.rs` to a real module:

- add explicit imports for hash maps, paths, process stdio, timeout duration,
  provider command/model contract types, SDK bridge JSON helpers, app errors,
  and UUID temp-file naming;
- expose only bridge args/input writing and command/model discovery helpers as
  `pub(super)` for runtime/history/turn callers and tests;
- keep mime detection, file path resolution, metadata loading, and model/command
  filtering internals private;
- keep OpenCode SDK bridge behavior unchanged.

## Fourth Slice

Convert `claude_sdk.rs` to a real module:

- add explicit imports for base64 encoding, hash maps, paths, process stdio,
  timeout duration, Claude model environment constants, provider command/model
  contract types, SDK bridge JSON helpers, app errors, and UUID temp-file naming;
- expose only shared repo-root lookup, bridge args/input writing, model alias
  resolution used by tests, and command/model discovery helpers as
  `pub(super)`;
- keep Claude settings/env loading, image mime/path handling, metadata loading,
  and command/model mapping internals private;
- keep Claude SDK bridge behavior unchanged.

## Remaining Slices

Proceed from smaller pure helpers toward stateful runtime surfaces:

- completed: Codex app-server control converted to a real module.
- completed: test fixture composition converted from textual `include!` to
  explicit `events` and `sdk` test submodules.

Do not move side-effectful runtime startup, stdin/stdout handling, active-turn
tracking, or DB writes without provider runtime fixture coverage.
