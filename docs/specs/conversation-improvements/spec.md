# Spec: Conversation (ACP) frontend + backend improvements

> Derived from `docs/codeg-vs-vibex-comparison.md`. Scope = the **conversation surface** (ACP session UX, rendering, robustness). Non-conversation gaps (i18n, experts library, settings depth, status-bar richness) are **out of scope** here — separate spec.
> **Hard rule: NO mock / stub / placeholder. Every feature is wired to a real data source / real ACP primitive (verified below) and must be production-usable.** If a capability isn't backed by real data, it is not built — we never fabricate.

## Objective

Bring VibeX's conversation experience to production-grade parity with codeg-main on the dimensions that affect *understanding what the agent is doing and trusting it*: rich permission review, sub-agent/delegation visibility, plan visibility, error/recovery legibility, in-session model/mode control, and live usage. All driven by data VibeX's ACP runtime already emits.

**Users:** developers running coding agents in VibeX. **Success looks like:** a user can (1) review an agent's requested action *with the actual diff/command* before approving; (2) see delegated sub-agents and their progress; (3) see the live plan and context-window usage; (4) understand and recover from errors (session expired, model unsupported, API retry) without reading logs; (5) switch model/mode/reasoning mid-session — all with zero fabricated data.

## Verified real data sources (the no-mock backbone)

| Feature | Real source (already emitted/available) | Evidence |
|---|---|---|
| Permission diff/command preview | `ConversationPermissionRequest` carries `raw_input`, `locations`, `content`, `title` | conversation.rs:339, tool patch raw_input:312 / locations:320 |
| Delegation/sub-agent viz | `delegation_started` / `delegation_completed` events (child_conversation_id, agent_type, task_preview, result) | conversationStore.ts `delegation` rows; conversation.rs delegation types |
| Plan viz | `plan_updated` event with entries (content/status/priority) | conversationStore.ts `plan_updated` |
| Live usage / context window | `UsageUpdated { ConversationUsage { context_window_max, … } }` | conversation.rs:586, events.rs:848 |
| Mode / config hot-switch | `SetSessionModeRequest`, `SetSessionConfigOptionRequest` wired in manager | manager.rs:1176/1227; `AgentSessionConfigOption`/modes parsed |
| Error codes / session-expired | ACP error codes (incl. ResourceNotFound), `AgentBindingLoadFailed`/`SessionConfigStale` events | manager.rs session/load handling; events.rs |
| Generated images | `ContentBlock::image_generation { revised_prompt, image }` | shared/types.ts:832; MessageTurnView renders inline already |
| Session fork | `agent-client-protocol` unstable feature exposes `ForkSessionRequest`/`ForkSessionResponse` (`session/fork`) | crates/agents/Cargo.toml; schema 0.12 unstable_session_fork |

Any item whose source turns out to be absent at build time is **descoped, not faked** (e.g., if a given agent emits no retry notifications, we surface real turn/connection state instead — never a fake "retrying" banner).

## Tech Stack

Backend: Rust (`crates/agents` ACP runtime, `src-tauri/src/conversation_service.rs` + `events.rs` + `commands/conversations.rs`, `crates/db` event-sourced projection). Frontend: React/TS — `frontend/src/features/conversation/*` (timeline store/hook), `frontend/src/components/logs/AgentTimelineConversation.tsx`, `frontend/src/components/NormalizedConversation/*` (MessageTurnView, tools/*), `frontend/src/components/agents/*`. Types via `#[derive(TS)]` → `shared/types.ts` (generated). Design tokens per `DESIGN.md` (macOS Tahoe Liquid-Glass).

## Commands

```bash
cargo check --workspace
cargo test --workspace
cargo clippy --workspace --all-targets --features qa-mode -- -D warnings
pnpm run generate-types         # after any #[derive(TS)] change
pnpm run generate-types:check
cd frontend && pnpm run check && pnpm exec eslint --max-warnings 0 src && pnpm exec vitest run
```

## Project Structure (where new code lives)

```
crates/agents/src/{conversation.rs,events.rs,manager.rs,runtime.rs}   → new ACP events/ops (mode set, fork, richer error)
src-tauri/src/conversation_service.rs + commands/conversations.rs      → new conversation commands (set_mode, set_config_option, fork)
src-tauri/src/events.rs                                                → map new AgentEvents → ConversationEvents
frontend/src/features/conversation/{conversationStore.ts,useConversationTimeline.ts}  → fold new event kinds; expose actions
frontend/src/components/NormalizedConversation/
  conversation/PermissionRequestCard.tsx   (NEW) → structured + diff preview
  conversation/DelegationCard.tsx          (NEW) → sub-agent/delegation
  conversation/PlanPanel.tsx               (upgrade TimelinePlanCard) → live plan
  tools/GeneratedImageCard.tsx             (NEW) → revised prompt + download
frontend/src/components/conversation-thread/{ContextUsageRing,SessionControls}.tsx (NEW)
```

## Design direction (Tahoe Liquid-Glass — `DESIGN.md` is the source of truth)

Do **not** introduce a new palette/typography — extend VibeX's established identity. Two-layer model: **message content stays opaque** (`--surface-*`), **controls/overlays use the glass chrome**. Per-surface signature (the one memorable, intent-encoding element each):

- **Permission card = diff-forward.** The signature is that the agent's *intent is the content*: a file_edit permission renders the **actual unified diff** (reuse the diff-view adapter), a command renders the **actual command** in a mono block, file ops list the **real locations**. Opaque card in the timeline; a glass action bar pins Allow / Allow-once / Reject with a clear destructive treatment. No modal blocking — anchored inline (upgrades today's `AgentPermissionPanel`).
- **Delegation card = a nested thread.** Status pill (running/completed/failed) + agent type + task preview; expands to the child conversation inline or "open in panel". Encodes the parent→child relationship structurally, not decoratively.
- **Plan panel = a pinned progress strip** at the top of the live turn (glass chrome, collapsible), entries with completed/in-progress/pending states reflecting real `plan_updated`; quiet, type-led, no numbered decoration unless the plan itself is ordered.
- **Context-usage ring** in the composer chrome: a real ratio from `UsageUpdated`; turns amber/red near the window limit. **Session controls** (model/mode/reasoning) live in the composer's glass control row.
- Motion: a restrained streaming "thinking" shimmer on in-flight tool/turn affordances; respect `prefers-reduced-motion`. Spend boldness on the diff-forward permission card; keep everything else quiet.

## Prioritized features (each: real source → backend → frontend → acceptance)

### P0-1 Rich permission review (with real diff/command preview)
- **Real source:** `ConversationPermissionRequest.{title, raw_input, locations, content}`.
- **Backend:** ensure the permission event carries full tool details to the frontend (extend the emitted `permission_requested` payload if currently trimmed); keep `respond_permission`闭环 unchanged.
- **Frontend:** new `PermissionRequestCard` — parse tool kind from `raw_input`; file_edit → unified diff via the existing diff adapter; command → mono command; render `locations`. Allow / Allow-once / Reject wired to existing `respondPermission`.
- **Acceptance:** approving a file edit shows the real diff that will be applied; rejecting blocks it; no fabricated content; works for command/file/web/plan tool kinds.

### P0-2 Sub-agent / delegation visualization
- **Real source:** `delegation_started`/`delegation_completed` (child_conversation_id, agent_type, task_preview, result).
- **Frontend:** `DelegationCard` replacing the plain side-row text; status pill, agent type, task preview, result; "open sub-conversation" navigates to the real child conversation. (Backend already emits; no fake state.)
- **Acceptance:** spawning a sub-agent shows a live card that transitions running→completed from real events and opens the real child transcript.

### P0-3 Error & recovery legibility (real signals only)
- **Real source:** ACP error codes (incl. ResourceNotFound on session/load), `AgentBindingLoadFailed`, `SessionConfigStale`, `turn_failed`, `UsageUpdated`.
- **Backend:** propagate a structured `code` (+ terminal flag) on agent errors → conversation error events; distinguish session/load `resource_not_found` from generic failure (map the real ACP error code).
- **Frontend:** turn-error row renders by code — "session expired → Reload / New conversation" actions for resource_not_found; "model not supported / auth required" with the real message; config-stale → "restart to apply" banner from the real event. **Retry visibility:** only if the agent emits real retry notifications do we show a "retrying" state; otherwise show real turn/connection status. No fabricated retry/progress.
- **Acceptance:** resuming a deleted session yields an actionable "expired" card (not a generic toast); model-unsupported shows the real error with retry/switch actions; no fake "retrying".

### P1-4 Live plan panel
- **Real source:** `plan_updated` entries.
- **Frontend:** upgrade `TimelinePlanCard` → pinned collapsible `PlanPanel` reflecting live entry statuses + completion count.
- **Acceptance:** plan entries update in real time as the agent reports them; collapsed/expanded persists per turn.

### P1-5 In-session model / mode / reasoning control (real set-mode/config)
- **Real source:** `SetSessionModeRequest` / `SetSessionConfigOptionRequest` (manager.rs) + parsed modes/`AgentSessionConfigOption`.
- **Backend:** new commands `conversation_set_mode` / `conversation_set_config_option` calling the wired manager requests; emit the resulting mode/config-updated events.
- **Frontend:** `SessionControls` in the composer chrome — model/variant + mode + reasoning/thinking (only options the agent actually advertises). Selecting calls the real backend; UI reflects the agent's confirmation event.
- **Acceptance:** switching mode/reasoning mid-session issues a real ACP request and the agent's behavior/labels update; only agent-advertised options are shown (no invented options).

### P1-6 Live context-window / usage indicator
- **Real source:** `UsageUpdated { context_window_max, input/output/cache tokens }`.
- **Frontend:** `ContextUsageRing` in the composer fed by the latest real usage; amber/red near limit. (Feeds existing EntriesContext token ring path — already partially wired.)
- **Acceptance:** ring reflects real token totals/window from `UsageUpdated`; hidden when the agent reports no window (never a fake number).

### P1-7 Generated-image card
- **Real source:** `ContentBlock::image_generation { revised_prompt, image }`.
- **Frontend:** `GeneratedImageCard` — image + revised-prompt caption + real download (Tauri save / web blob) + preview. (MessageTurnView already renders the raw image inline; upgrade to a card.)
- **Acceptance:** an agent-generated image shows the real revised prompt and downloads the real bytes.

### P1-8 Streaming polish + cross-turn grouping
- **Frontend:** restrained streaming shimmer on in-flight tool/turn; extend `messageTurnAggregate` to merge consecutive assistant turns / group goal-runs (data already in the timeline). No new data; pure rendering.
- **Acceptance:** multi-turn tool runs read as one coherent group; reduced-motion respected.

### P2-9 Session fork (conversation branching) — gated on real capability
- **Real source:** ACP `session/fork` (`ForkSessionRequest`/`Response`) via the unstable feature; **dynamic** capability (only enable when the connected agent actually advertises fork — fix today's static `metadata.rs` claim so the UI never offers an unsupported op).
- **Backend:** implement the fork operation in `manager.rs`/`runtime.rs` (port codeg's `fork_session` flow: ACP request → new acp session id → bind a sibling conversation), command `conversation_fork`.
- **Frontend:** "fork from here" affordance → opens the new branched conversation.
- **Acceptance:** fork creates a real new ACP session branched at the point and a real sibling conversation; the affordance only appears when the agent advertises fork.

## Testing Strategy

- **Backend:** unit tests for new projection folds (delegation/plan/usage/error-code) in `crates/db` (pattern: existing `conversation_projection.rs` tests); manager tests for set-mode/config + fork request shaping (in-memory driver). `cargo test --workspace` + clippy(qa-mode).
- **Frontend:** vitest component tests per new card (PermissionRequestCard renders real diff from a sample `raw_input`; DelegationCard transitions on events; PlanPanel folds entries; ContextUsageRing maps usage; error card actions). Reducer tests in `conversationStore.test.ts` for new event kinds. `tsc` + `eslint --max-warnings 0` + `vitest run`.
- **No-mock test discipline:** tests use realistic event/payload fixtures shaped like the actual ACP events (not invented shapes); the app path always reads live events — fixtures exist only in tests.
- **Manual smoke per feature** (run the app): permission diff approve/reject, sub-agent run, plan update, mode switch, usage ring, generated image, (fork if agent supports).

## Boundaries

- **Always:** wire to the verified real source; run the full gate (cargo check/test/clippy-qa, generate-types:check, frontend tsc/eslint/vitest) per feature; align to `DESIGN.md` tokens; `pnpm run generate-types` after any `#[derive(TS)]` change; keep the ACP-only rule (no executor reintroduction).
- **Ask first:** DB migration; adding a dependency; enabling a new unstable ACP feature flag beyond what's present.
- **Never:** ship mock/stub/placeholder or fabricated data of any kind; advertise an op the agent doesn't support (use dynamic capability); hand-edit `shared/types.ts`; block the UI with a modal where an inline surface fits; break reset-to-here / streaming / the event-sourcing core.

## Success Criteria

1. Every P0 feature ships **fully data-backed** (diff/command from real `raw_input`; delegation/plan/error/usage from real events) — a code review confirms no mock/placeholder/fabricated branch.
2. Permission review shows the real diff/command and the respond闭环 still gates the agent.
3. Delegation, plan, and usage update live from real events; errors are actionable by real code (session-expired/auth/model).
4. In-session mode/reasoning switch issues a real ACP request and is reflected by the agent; only advertised options shown.
5. Generated images download real bytes; streaming reads as coherent groups.
6. Fork (if built) only appears when the agent advertises it and creates a real branched session.
7. Full gate green; no new clippy/eslint warnings; types regenerated.

## Resolved decisions (2026-06, locked)

1. **Scope = conversation only.** i18n / experts / settings-depth are explicitly deferred to separate specs.
2. **Permission UX = inline/anchored** (VibeX style), NOT a blocking modal. P0-1 builds an in-timeline card with a pinned glass action bar.
3. **Agents DO emit real ACP retry notifications** → P0-3 retry visibility is **built for real** (map the actual ACP retry notification → conversation event → inline state). No fake banner; the source is the real notification.
4. **Config options are per-agent, driven by what ACP advertises** (`ConfigOptionUpdate` / `AgentSessionConfigOption`) — agents differ. P1-5's `SessionControls` renders **only** the options the connected agent actually exposes; nothing hard-coded or assumed uniform across agents.

## Open Questions (remaining)

- **Open:** the exact ACP notification shape that carries retry info (which `session/update` extension or notification field) — pin down in PLAN by reading the ACP schema + live traffic, then map it 1:1.
- **Open:** fork (P2-9) still depends on the connected agent advertising `session/fork` at runtime; built behind dynamic capability, stays inert for agents that don't advertise it.
```

