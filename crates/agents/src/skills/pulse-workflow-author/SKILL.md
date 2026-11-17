---
name: pulse-workflow-author
description: Dual-Primitive Pulse workflow graph composition and patching. Use when authoring *.dimo-workflow.json graphs, mixing ephemeral Session and persistent Bot steps, adding BoundedLoop/WaitForEvent/UserGate/OutboxAction nodes, or calling workflow_graph_patch.
---

# Pulse Workflow Author

Compose and patch Dual-Primitive Pulse workflows (`*.dimo-workflow.json`) using `workflow_graph_patch` from the built-in `Dimo-superagent-mcp` and wire trigger rules with `pulse_rule_upsert`. For single-target event rules without a multi-step DAG, use `pulse-automation-architect`.

## Composition sequence

1. **Read or scaffold the graph** — For an existing `*.dimo-workflow.json`, call `workflow_source_read` first to capture its `sha256:<hex>` `revision`. For a new workflow, start with `workflow_graph_patch` `op: "apply_preset"` using the closest orchestrator preset below.
   - *Done when*: Base `definition` (and `expectedRevision` if editing an existing file) is in hand.
2. **Assign primitives per step** — Partition agent work strictly between `session` (ephemeral clean context + isolated worktree) and `bot` (persistent `memberId` + rolling memory without context reset). Bound every retry cycle with `bounded_loop` (`maxIterations` `1..=50`) and every external async pause with `wait_for_event` (`timeoutSeconds >= 5`).
   - *Done when*: Every step's primitive matches its context/isolation contract in the Node Reference below.
3. **Apply declarative graph patches in one batch** — Call `workflow_graph_patch` with `operations` (`add_step`, `update_step`, `remove_step`, `connect_steps`, `disconnect_steps`), passing `expectedRevision` when writing to an existing `path`.
   - *Done when*: `workflow_graph_patch` returns `valid: true` and `violations: []`. If `valid: false`, fix **every** violation reported in `violations` in the immediate next call (never one error per turn).
4. **Verify end-to-end trigger & bindings** — Publish with `workflow_publish` when ready and upsert the matching `PulseRuleSpec` (`kind: "workflow"`, `workflowId`, `pinnedVersion`) via `pulse_rule_upsert` (inspecting connectors with `pulse_connector_health`).
   - *Done when*: `workflow_validate` reports `valid: true` and the matching Pulse trigger rule is saved.

## Dual-Primitive split: `session` vs `bot`

Mixing both primitives in one DAG gives institutional memory where context helps and clean sandboxes where accumulated history hurts:

| Primitive | Context & workspace contract | Use for | Required fields |
| :--- | :--- | :--- | :--- |
| **`session`** | `refreshContext: true` (fresh conversation every run), `workspaceIsolation: "isolated_worktree"` (default) \| `"project_root"` \| `"scratch"` | Parallel code edits, test runs, git branch work, deterministic diffs free from prior ticket hallucinations | `id`, `kind: "session"`, `agentId`, `prompt` |
| **`bot`** | `preserveContext: true` (fixed primary or per-thread conversation, zero context reset), serialized by `mailboxPolicy` (`"fifo_serial"` \| `"coalesce_batch"` \| `"steer_active"`) | Ticket triage, architectural planning, cross-PR release ledgers, alert deduplication, reviewer sign-off | `id`, `kind: "bot"`, `memberId`, `prompt` |

When converting an existing node between `"session"` and `"bot"` via `update_step`, pass the new `kind` plus `agentId` (for `session`) or `memberId` (for `bot`); `workflow_graph_patch` strips stale fields from the prior primitive automatically.

## Orchestration node reference

| Step `kind` | Contract & required invariants |
| :--- | :--- |
| **`group_stage`** | Posts/dispatches into `spaceId` with `dispatchMode` (`specific_seat`, `mention_seats`, `moderator_triage`, or `broadcast_log_only`) and `prompt`. |
| **`user_gate`** | Pauses or notifies a human via `interactionKind` (`"approval"` \| `"ask_form"` \| `"notify"`) and `title` (plus optional `body`, `schema`). |
| **`bounded_loop`** | Repeats `bodyStepIds` (non-empty array of existing step IDs, excluding self) until RFC 6901 `conditionPointer` (starts with `/`, e.g. `"/approved"`) is truthy or `maxIterations` (`1..=50`) is reached. Always pair non-trivial loops with `onExhaustedStepId` pointing to a `user_gate` escalation step. |
| **`wait_for_event`** | Suspends the Saga until an event in `eventTypes` (non-empty) arrives on `threadKeyPointer` (starts with `/`, e.g. `"/threadKey"`), bounded by `timeoutSeconds >= 5` and optional `onTimeoutStepId` fallback. |
| **`outbox_action`** | Emits durable side effects (`actionKind`: `"reply_channel"` \| `"emit_event"` \| `"webhook_post"` \| `"issue_update"`) rendered from `payloadTemplate`. |

## Five canonical presets (`apply_preset`)

Scaffold with `{ "op": "apply_preset", "preset": "<kind>", "params": { "agentId": "...", "memberId": "..." } }`, then customize in the same `operations` array:

1. **`direct_reflex`**: `execute_session` (`session`) -> `reply_outbox` (`outbox_action`). Fast isolated execution + source reply.
2. **`superagent_router`**: `triage_bot` (`bot`, `fifo_serial`) -> `implement_session` (`session`, `isolated_worktree`, bound to `steps.triage_bot.output`) -> `reply_source` (`outbox_action`).
3. **`hybrid_pipeline`**: `plan_bot` (`bot`) -> `code_session` (`session`) -> `verify_bot` (`bot`) -> `review_loop` (`bounded_loop`, `conditionPointer: "/approved"`, `maxIterations: 3`) -> `release_approval` (`user_gate`) -> `publish_outbox` (`outbox_action`).
4. **`event_saga`**: `prepare_session` (`session`) -> `await_ci_signal` (`wait_for_event` on `github.ci.passed` / `github.pr.approved`, `onTimeoutStepId: "sla_escalation_gate"`) -> `finalize_bot` (`bot`), with `sla_escalation_gate` (`user_gate`) handling timeouts.
5. **`window_aggregator`**: `digest_bot` (`bot`, `mailboxPolicy: "coalesce_batch"`) -> `notify_digest` (`user_gate`, `notify`).

## Canonical ground-truth examples (`examples/workflows/`)

Read the closest example before authoring a new workflow so trigger metadata, loop guards (`not_bot_actor`), and human-readable summaries match the Workbench contract:

- `examples/workflows/github-ci-autofix.dimo-workflow.json` — GitHub CI failure -> isolated `session` fix -> PR/commit reply (`outbox_action`).
- `examples/workflows/feishu-mention-triage.dimo-workflow.json` — Feishu `@mention` -> `bot` triage -> `session` code check -> Feishu reply.
- `examples/workflows/daily-repo-digest.dimo-workflow.json` — Weekday cron `30 9 * * 1-5` -> `bot` digest -> desktop `notify` (`user_gate`).
- `examples/workflows/pr-review-gate.dimo-workflow.json` — GitHub PR -> `bot` review -> `session` verification -> human `approval` (`user_gate`) -> PR comment.

## Human-semantic card summaries & atomic trigger sync

- **Every automation task is a Workflow**: Even 2-3 step reflexes are authored as `WorkflowDefinition` graphs (`[trigger] -> [session | bot | group_stage] -> [outbox_action | user_gate]`) so humans inspect a single visual topology.
- **Write human-first card copy**: Populate `[dimo-studio:v1]` `trigger.title`, `session.outputDescription`, `bot.outputDescription`, `user_gate.titleTemplate`, and `outbox.title` with concise natural-language phrases (never raw `{{payload.*}}` expressions or internal step IDs).
- **Sync trigger rule on publish**: After `workflow_publish`, always upsert the matching `PulseRuleSpec` (`taskMeta: { taskKind: "workflow_trigger" }`, `targets: [{ kind: "workflow", workflowId, pinnedVersion }]`, including `not_bot_actor` on external webhooks) so enabling/disabling in the Task List works immediately.

## Graph hygiene & CAS rules

- **Keep `dependsOn` acyclic**: `workflow_graph_patch` runs Kahn topological validation across `dependsOn`; express iterative back-edges exclusively via `bounded_loop.bodyStepIds`, never cyclic `dependsOn`.
- **Pass `inputBindings` explicitly**: When `connect_steps` links producer output to consumer input, specify `bindingKey` and `bindingExpr` (e.g. `"steps.triage_bot.output"`).
- **Honor CAS `expectedRevision`**: Saving over an existing `*.dimo-workflow.json` requires the exact `sha256:<hex>` revision from the latest read/patch; on `cas_revision_mismatch`, re-read and reconcile before patching.
