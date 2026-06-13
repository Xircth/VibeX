# Conversation Subsystem — Full Alignment to codeg

> Goal (owner decision, 2026-06-14): align VibeX's conversation/session
> implementation **completely** to `C:/Users/Administrator/Documents/Projects/codeg-main`,
> dropping all legacy/compat code rather than maintaining it. Scope decision:
> **full frontend + backend storage alignment**. Auxiliary decision: scripts /
> todos / token-usage / retry UI / devserver preview are **kept but moved out of
> the conversation timeline** (codeg does not render these in the timeline).
>
> This supersedes and completes Phases 02 (conversation-rendering) and 03
> (conversation-aggregation) of `docs/specs/codeg-alignment`, plus a backend
> storage migration. codeg is the Apache-2.0 reference; ported logic must keep
> upstream attribution. We align the **architecture/logic**, not the framework
> (VibeX stays Vite + React 18; codeg is Next.js 16 + React 19).

## Target architecture (from codeg source map)

**One unified conversation timeline, fed by ACP events — no dual "live vs DB"
path.**

- **Two cooperating frontend stores:**
  - *Transport store* — keyed by connection/tab; owns the raw ACP event stream
    and transient state (live message, pending permission, pending question,
    modes, config options, usage). Reduces `EventEnvelope { seq, connection_id,
    ... }` into per-connection state; `seq` is the dedup anchor against snapshot
    replay.
  - *Conversation runtime store* — keyed by `conversationId`; owns the single
    rendered timeline. Holds, per session: `detail` (DB-loaded), `localTurns`
    (promoted/completed), `optimisticTurns` (pending user sends), `liveMessage`
    (mirrored from transport), `syncState`, `externalId`, `sessionStats`.
- **`getTimelineTurns(conversationId)`** is the only render source: concatenates
  phases `persisted` (detail.turns) + `persisted` (localTurns) + `optimistic` +
  `streaming` (`buildStreamingTurnsFromLiveMessage`), then dedups by `[role, id]`
  (assistants keep-last so live wins; users keep-first so persisted wins).
  Memoized in a WeakMap keyed by the session object for reference stability.
- **One data vocabulary** (live and persisted converge on it):
  - `MessageTurn { id, role: user|assistant|system, blocks: ContentBlock[],
    timestamp, usage?, duration_ms?, model?, completed_at? }`
  - `ContentBlock` tagged union: `text` | `image` | `image_generation` |
    `tool_use` | `tool_result` | `thinking` (+ frontend live-only `plan`).
  - Tool results correlate to tool calls by `tool_use_id` (positional fallback).
  - Permissions/questions are transient transport state rendered above the
    composer — NOT timeline blocks. Usage is turn metadata + `SessionStats`.
- **Backend storage = metadata only + re-parse:**
  - DB holds `folder` + `conversation` rows. `conversation` keyed by unique
    `(external_id, agent_type)`; columns: title, title_locked, status, model,
    git_branch, external_id, parent_id, parent_tool_use_id, delegation_call_id,
    message_count, created_at, updated_at, deleted_at (soft delete), pinned_at.
    **No message/turn table.**
  - Transcript is **re-parsed from each agent CLI's own session files** on
    detail load (7 parsers → `MessageTurn[]`). Live in-flight turn lives only in
    memory and is streamed as events; `apply_in_flight_message_id` /
    `in_flight_user_turn_id` reconcile the live prompt with the parsed prompt so
    a mid-turn load renders seamlessly.
  - DB writes are metadata-only side-effects on a decoupled lifecycle subscriber
    (`SessionStarted` → bind `external_id`; `TurnComplete` → status; etc.), off
    the streaming hot path.

## Gap vs VibeX today

| Dimension | codeg (target) | VibeX (current) |
|-----------|----------------|-----------------|
| Render source | one `getTimelineTurns` (phases) | dual path `usesAgentTranscript ? agentTranscriptEntries : DB-history` |
| Stores | transport + conversation runtime | `agentWorkbench`/`eventsByScope` + `EntriesContext` + `ExecutionProcessesContext` |
| Model | `MessageTurn` / `ContentBlock` | `NormalizedEntry` / `ActionType` via `DisplayConversationEntry` |
| Transcript source | re-parse agent session files; DB metadata only | persist `agent_events`, rebuild from events |
| Scripts/todos/etc. | not in timeline | ride the "legacy" DB modules (load-bearing) |

## Phases (each gated; do not advance until green)

> Prerequisite P0: establish a **clean base**. The current master working tree
> mixes the owner's settings WIP with the uncommitted xterm/nav fixes from the
> prior task. Commit/segregate those first, then branch `feature/conversation-
> alignment` (own worktree) off a clean master. The xterm fix
> (`useTauriTerminal.ts`) is unrelated and must be preserved.

- **Phase A — Unified data model (foundation).** Define Rust `MessageTurn`,
  `ContentBlock` (+ `ImageData`, `AgentExecutionStats`, `AgentToolCall`),
  `TurnUsage`, `SessionStats`, `ConversationSummary`/`DbConversationSummary`,
  `ConversationDetail`/`DbConversationDetail`, `FolderInfo`, with `ts-rs`
  derivation → `shared/types.ts`. No behavior wired yet.
  - Gate: `cargo check -p db -p agents`, `pnpm run generate-types:check`,
    `pnpm run frontend:check`.

- **Phase B — Backend storage (metadata-only DB + folder/conversation).**
  Migration for `folder` + `conversation` tables (metadata, unique
  `(external_id, agent_type)`, soft-delete, title_lock, pinned, delegation cols);
  sea-orm/sqlx entities + a `conversation_service` (create / update_status /
  update_title(lock) / pinned / soft-delete / bind external_id / list / detail).
  - Gate: migration replays; `cargo test` for the service; `prepare-db:check`.

- **Phase C — Agent session-file parsers (the Phase-03 work).** 7 parsers
  (Claude / Codex / OpenCode / Gemini / Cline / OpenClaw / Hermes) → `MessageTurn[]`
  + `SessionStats`; project auto-discovery + path matching; content normalization
  (tool-call rebuild, tool_result correlation). Port from codeg with Apache-2.0
  attribution; VibeX-authored implementation.
  - Gate: per-agent fixture transcripts parse to expected `MessageTurn[]`;
    `cargo test -p agents`.

- **Phase D — Live ACP → turn pipeline + conversation commands.** In-memory
  live turn (LiveMessage), event → state `apply_event` + monotonic `seq` + ring
  buffer; conversation commands (`list`/`detail`/`get_folder_conversation_with_
  live`) returning `DbConversationDetail` (DB metadata + parsed turns +
  `in_flight_user_turn_id`); push live updates over the existing per-connection
  channel. Lifecycle subscriber writes metadata only.
  - Gate: integration test for create→bind→stream→complete; in-flight reconcile.

- **Phase E — Frontend stores.** Transport store (ACP events; keyed by
  connection/tab) + conversation runtime store (keyed by conversationId) with
  `getTimelineTurns` phases + `buildStreamingTurnsFromLiveMessage`; WeakMap +
  per-turn adapter memoization; optimistic send / promote / sync-metadata.
  - Gate: store reducer unit tests (event→turns, phase merge, dedup, optimistic
    lifecycle); `pnpm vitest run`.

- **Phase F — Frontend rendering on the unified timeline.** `MessageListView` +
  virtualized thread + message bubble + content-parts adapter on
  `MessageTurn`/`ContentBlock`, reusing the Phase-02 Streamdown-equivalent
  (Shiki/KaTeX/Mermaid). Message nav scroll-spy on user turns. **Remove the dual
  path** (`usesAgentTranscript`, `agentTranscriptEntries` vs DB-history `entries`,
  `buildAgentTranscriptEntries`, the `NormalizedEntry` conversation render).
  - Gate: rendering/adapter tests; desktop smoke of send→stream→complete.

- **Phase G — Relocate auxiliaries & remove legacy.** Move scripts / next-action /
  token-usage / retry UI / devserver preview to dedicated panels/state (keep
  features, out of the timeline). Remove the now-dead conversation halves of
  `useConversationHistory` / `EntriesContext`'s conversation role; keep their
  still-live script/todo/devserver duties relocated. Delete `agent_events`
  transcript reliance if fully superseded.
  - Gate: full gate (`pnpm run check`/`lint`, `cargo test --workspace`, `vitest`),
    feature parity check for scripts/todos/retry/devserver.

## Risks / notes

- **Re-parse vs persist (Phase C/D) is the biggest fork.** It makes VibeX depend
  on agent CLI session files staying on disk; this is codeg's deliberate design.
  Confirm acceptable (vs. self-contained DB history) before Phase C.
- Phase F removes the conversation use of `NormalizedEntry`; verify no other
  surface (kanban, imported-session viewer) depends on it before deletion.
- `VirtualizedList.tsx` is in the owner's WIP and was edited by the prior task —
  Phases E/F replace it; coordinate the rebase.
