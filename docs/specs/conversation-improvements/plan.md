# Plan + Tasks: Conversation improvements (grounded)

> Companion to `spec.md`. PLAN-phase findings are **first-hand verified** (not from the auto-comparison, which overstated several gaps). Implementation order = P0 → P1 → P2; each task is a verifiable vertical slice with the full gate (cargo check/test/clippy-qa + generate-types:check + frontend tsc/eslint/vitest). **No mock.**

## Verified findings that shape the plan

1. **REAL BUG (P0-1 is also a fix, not just polish):** after the legacy cleanup, `AgentPermissionPanel` is **orphaned** (`<AgentPermissionPanel` rendered nowhere). The ACP conversation view (`AgentTimelineConversation` → `ConversationSideRows`) renders a permission as a **display-only** `{title, status}` div — **no Allow/Reject**. The respond闭环 exists end-to-end (`useConversationTimeline.respondPermission` → `conversation_respond_permission` → `conversation_service.respond_permission` → `agent_runtime.respond_permission`) but **no UI calls it**. → permissions are currently **unanswerable** in-session.
2. **Permission payload is full on the wire, trimmed in projection:** the live `permission_requested` conversation event carries the full `AgentPermissionRequest { title, details: Option<JsonValue>, options: Vec<AgentPermissionOption{id,label,kind,description}> }` (events.rs:897). The DB record stores `details_json` + `options_json` (conversation_projection.rs:182). But `ConversationPermissionView` only projects `{permission_id, title, status}` (conversation.rs:654) and the frontend `conversationStore` live-fold trims to the same. → extend the view + populate both paths.
3. **Plan / delegation / usage events are real and already folded** in `conversationStore` (`plan_updated`, `delegation_started/completed`, `usage_updated`) — UI just renders them thinly. No backend event work needed for P1-4/P0-2/P1-6.
4. **Mode/config hot-switch backend is wired** (`SetSessionModeRequest`/`SetSessionConfigOptionRequest`, manager.rs:1176/1227); session_mode_updated / session_config_options_updated conversation events exist. Need: commands + frontend controls driven by **agent-advertised** options only.
5. **Generated images render inline already** (MessageTurnView `case 'image_generation'`); upgrade to a card (revised prompt + download).
6. **Fork primitive present in dep** (`agent-client-protocol` unstable) but op unimplemented + `metadata.rs` statically claims `SessionFork` → must become dynamic (advertise only when the agent really supports it).
7. **OPEN (pin in P0-3):** exact ACP notification that carries Claude retry info — read the ACP schema / live `session/update` to map it 1:1 (user confirmed agents emit it).

## Tasks (ordered)

### P0-1 — Rich, answerable permission card (real diff/command + respond闭环)  ← also fixes the un-answerable bug
- [ ] **T1.1 Backend: surface permission details/options.** Add `details: Option<serde_json::Value>` + `options: Vec<AgentPermissionOption>` to `ConversationPermissionView` (conversation.rs); in `project()` (conversation_projection.rs:647) populate from `ConversationPermissionRecord.{details_json, options_json}` (parse). Acceptance: `cargo test -p db` projection test asserts a reloaded permission view carries details+options. Files: conversation.rs, conversation_projection.rs (+test).
- [ ] **T1.2 generate-types** → `ConversationPermissionView` in shared/types.ts gains details+options. Verify `generate-types:check`.
- [ ] **T1.3 Frontend store: stop trimming.** `conversationStore.ts` `permission_requested` fold keeps `details` + `options` from `event.request.request`; `load_success` view already carries them post-T1.1. Test: `conversationStore.test.ts` keeps details/options.
- [ ] **T1.4 `PermissionRequestCard.tsx` (NEW).** Render title; parse `details` → file_edit ⇒ unified diff (reuse `EditDiffRenderer`/`DiffCard`), command ⇒ mono block, locations ⇒ list, else pretty JSON; render `options` as buttons styled by `kind` (allow_* vs reject_*); on click call `respondPermission(permission_id, {kind:'selected', option_id} )` / Cancelled; disable when `status!=='pending'`. Inline/anchored (NOT modal). Design per DESIGN.md (opaque card + glass action bar; diff-forward signature).
- [ ] **T1.5 Wire into timeline.** `AgentTimelineConversation` `ConversationSideRows`: replace the display-only permission row with `<PermissionRequestCard … onRespond={conversation.respondPermission} />`. Test: card renders diff from sample details + calls respond.
- [ ] Gate: full suite. **Acceptance:** a real file-edit permission shows the real diff and Allow/Reject actually gate the agent; reload keeps the card.

### P0-2 — Delegation / sub-agent card
- [ ] **T2.1 `DelegationCard.tsx` (NEW)** from real `delegation` rows (status pill running/completed/failed, agent_type, task_preview, result; "open child conversation" → navigate to child_conversation_id). Replace the plain delegation side-row text. Tests for transitions. (No backend change — events already folded.)
- [ ] Gate. **Acceptance:** sub-agent run shows live card from real events + opens the real child transcript.

### P0-3 — Error & recovery legibility (structured codes, real signals) ✅ DONE (retry deferred)
- [x] **T3.1 Backend: structured error code.** `classify_session_load_error` + `acp_error_code_str` (manager.rs) map the agent's **real** `acp::Error.code` (ResourceNotFound -32002, AuthRequired -32000, …) into `SessionLoadFailureReason` (now carried by `AgentEvent::SessionLoadFailed`) and a stable string on `AgentErrorEvent.code`. `ConversationError.code` is populated for `turn_failed` from the ACP code (events.rs). Tests: `session_load_errors_classify_by_real_acp_code`, `acp_error_codes_map_to_stable_strings` (agents); `permission_view_*` unaffected.
- [x] **T3.2 generate-types + store fold.** `AgentErrorEvent.code` + structured `SessionLoadFailureReason` exported; `conversationStore` folds `agent_binding_load_failed` into a code-aware notice (`sessionLoadFailedNotice`) and the backend projection reload path matches it.
- [x] **T3.3 Frontend `TurnErrorCard`.** Code-aware: `cancelled`/`request_cancelled` ⇒ neutral "已取消" (no reload); `resource_not_found` ⇒ "代理会话已过期" + **重新加载会话** (real `resetAndReload`); `auth_required` ⇒ "需要重新认证" + message; else ⇒ message + raw code. Session-load notices render via the same classification. Config-stale already shown via existing `SessionConfigStale` notice.
- [x] Gate: agents/db/vibex(qa-mode) clippy + tests green; frontend tsc/eslint/166 conv tests + generate-types:check green.
- [ ] **T3.4 Retry banner — DEFERRED (no real source).** ACP `agent-client-protocol` 0.11.1 has **no** `session/update` notification carrying retry/backoff/overloaded info (verified: `SessionUpdate` has no such variant; any unknown notification is dropped as `RawAcpDiagnostic`). Per the no-mock constraint we do **not** synthesize a retry banner. Revisit if/when a future ACP version (or a specific agent) emits a real retry notification.

### P1 — enrichment/control (after P0)
- [x] **T4 Plan panel — already present.** `plan_updated` folds into the timeline and `TimelinePlanCard` renders status + completed/total. (No further work needed; a pinned collapsible variant is optional polish.)
- [x] **T5 Session controls (mode hot-switch) — DONE.** Real ACP path: `conversation_start_turn` now carries `mode_override` + `config_overrides` → `start_turn` merges over profile/slash defaults (`merge_user_prompt_overrides`, user wins) → `send_prompt` → real ACP `SetSessionMode`/`SetSessionConfigOption`. `AgentSessionConfigOverride` exported. Frontend: `conversationStore` folds `session_mode_updated`/`session_config_options_updated` (reload-robust — survives detail refresh; re-advertised on binding ready); `useConversationTimeline` exposes them; `AgentTimelineConversation → EntriesContext` bridge (mirrors the usage-ring flow); `SessionModeSelector` in the composer `ActionBar` (renders **only** agent-advertised modes), selection threaded through `useFollowUpSend → sendAgentRuntimeTurn → startTurn`. Tests: backend merge (2), store fold + reload persistence (2), selector behavior (4). Config-option UI is modes-first; backend already threads config overrides for a future select UI.
- [x] **T6 Context-usage ring — already present.** `latestTokenUsage` → `EntriesContext.setTokenUsageInfo` → `TokenUsageIndicator` in `SessionComposerTopbar` (percentage ring). No work needed.
- [x] **T7 GeneratedImageCard — DONE.** Unified `image_generation` block now renders `GeneratedImageCard` (clickable `ImagePreviewDialog`, revised prompt, real download, hosted-uri preferred) instead of a bare `<img>`. Tests (4).
- [x] **T8 Streaming polish — largely present.** Shimmer (`conv-shimmer-text`), spinner, and streaming placeholders already exist and **already respect `prefers-reduced-motion`** (conv-components.css:72-77). Deferred (low value, render-only): cross-turn goal grouping in `messageTurnAggregate`.

### P2 — branching
- [ ] **T9 Session fork:** make `metadata.rs` fork capability dynamic (advertise only when agent supports `session/fork`); implement `manager.rs` fork op + `conversation_fork` command (port codeg flow) + "fork from here" affordance → branched session.

## Risks / sequencing
- T1.1 type change is **additive + cascades to conversationStore** (must populate new fields same turn or TS breaks) — do T1.1→T1.3 together.
- P0-3 T3.1 retry depends on the open ACP-notification investigation; if a given agent emits none, that agent simply shows real turn state (no fake) — feature still ships for agents that do.
- Each task ends green on the full gate before the next.
