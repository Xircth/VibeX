# PRD: ACP Agent Migration

Created: 2026-04-28T09:57:34Z

## Problem

Codex, Claude Code, and OpenCode previously used separate invocation protocols.
That leaked provider-specific behavior into executor runtime, settings,
session continuity, setup, approval, and log-normalization code. The Codex
path also depended on pinned app-server protocol crates, which made CLI version
drift a runtime failure mode.

## Goal

Make Codex, Claude Code, and OpenCode execute through the shared ACP runtime
only, without legacy fallback transports.

## Requirements

- Codex runtime uses the ACP-backed executor and no longer launches Codex
  app-server.
- Claude Code runtime uses the ACP-backed executor and no longer launches the
  private stream-json/control protocol path.
- OpenCode runtime uses `opencode acp` through the ACP-backed executor and no
  longer starts the HTTP SDK server path.
- Session continuity and setup-helper behavior are capability driven.
- Settings preflight/install/update actions target ACP adapters or ACP launch
  commands, not removed legacy transports.
- Old Codex app-server dependencies and patch entries are removed.
- Existing public profile shape remains readable so existing user config can
  still select Codex, Claude Code, and OpenCode providers.

## Non-Goals

- No backward-compatible runtime fallback to app-server/private/HTTP SDK
  transports.
- No new provider migration beyond Codex, Claude Code, and OpenCode.
- No frontend redesign outside the existing settings/conversation surfaces.

## Acceptance Criteria

- `cargo check -p executors` passes.
- `cargo check -p vibex` passes.
- Repository search finds no active `codex-app-server-protocol`,
  `codex-protocol`, `codex-core`, `app-server`, `stream-json`, or old pinned
  Codex launch path in production source.
- Agent settings preflight checks the ACP runtime launcher and reports ACP
  adapter versions.
- `run_agent_setup` calls the executor setup helper generically.
