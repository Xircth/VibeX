# Collaboration member identity (phase 1)

Phase 1 separates *who* a collaborator is (a **member**) from *where* it talks
(a **thread**). Each `(member, thread)` pair owns exactly one conversation.

## Tables (`20261024010000_collaboration_member_identity.sql`)

| table | purpose |
| --- | --- |
| `collaboration_members` | one row per member: name, `role_id`, agent, workspace |
| `collaboration_threads` | `group` threads (id = space id) and `direct` threads (id = `direct:<member_id>`) |
| `collaboration_thread_members` | PK `(thread_id, member_id)`, `conversation_id` UNIQUE, `last_seen_message_id`, `status` |
| `member_activity` | per-member activity log (empty in phase 1) |
| `member_facts` | per-member facts, scope `global`, `private` or `thread:<id>` (empty in phase 1) |

`collaboration_space_members` stays and is the seat projection that delivery,
receipts and dedupe still read. A seat's `conversation_id` always equals the
binding of its `(member, thread)` once resolved.

## Data migration

`MemberIdentityMigration::run` (called from `db::run_migrations`) is
idempotent; every insert is `ON CONFLICT DO NOTHING` and ids are derived:

* member id = UUIDv5(`vibex-member:<conversation>`), inheriting name and
  `role_id` from `conversation_personas` (else the session name).
* every space becomes a group thread with the same id, so its messages,
  deliveries and receipts need no rewrite.
* seats in the undecided space (`unassigned:<workspace>`) become the member's
  direct thread.
* seats are walked in join order (`rowid`). A conversation seated in several
  spaces keeps the original conversation for the earliest-joined space; every
  later space gets a new conversation in the same workspace (id
  UUIDv5(`vibex-member-thread:<member>:<thread>`), persona copied) and that
  seat is repointed to it.
* seats whose session or space is gone are skipped.

## Runtime

* `resolve_session(member_id, thread_id) -> conversation_id` creates the
  conversation when missing (db crate does rows; conversations crate adds the
  persona notice and role mode/config).
* space delivery (`post_to_space*`) resolves each seat through its identity
  before submitting; delivery/receipt/dedupe logic is unchanged.
* `send_session_input` accepts `member_id` + `thread_id` instead of
  `conversation_id`; the host resolves (workspace checked) and then sends.
* the single-space restriction is gone: moving a member into a space no
  longer removes it from the workspace's other spaces. Joining a second space
  creates a new conversation for that thread.
* an agent creating a space joins through its member identity (see Phase 1
  follow-ups); there are no shared seats.

## Rollback

The change is additive. To roll back, deploy the previous build and drop the
five tables (`DROP TABLE collaboration_thread_members, collaboration_threads,
collaboration_members, member_activity, member_facts`) and delete the
`_sqlx_migrations` row for `20261024010000`. Repointed seats still reference
valid sessions, so the old code keeps working; the forked conversations remain
as ordinary conversations (one per extra space) rather than being merged back.

## Phase 1 follow-ups

* The backfill runs in **one transaction** (`MemberIdentityMigration::run`);
  a failure rolls back every member, thread and binding it created.
* `20261024020000_collaboration_identity_foreign_keys.sql` rebuilds
  `collaboration_thread_members`, `member_activity` and `member_facts` with
  `REFERENCES collaboration_members / collaboration_threads ON DELETE CASCADE`
  (orphans are dropped during the copy). Rollback: rebuild without the
  references.
* Agent-created spaces seat the creator through member identity like every
  other seat (no shared seats). A caller acts in a space through its
  member's seat there (`caller_seat`), so the creator's original
  conversation can still post; it never receives its own posts.
* `last_seen_message_id` advances (never backwards) after each successful
  delivery to the member's thread session.

# Phase 2

| area | migration | entry points |
| --- | --- | --- |
| receipts + origin + packing | `20261024030000_collaboration_receipts_origin.sql` | `list_message_receipts`, host `space.submit`, `space.receipts`, event `vibex://collaboration-receipts-changed` |
| sleep / wake cap | `20261024040000_collaboration_session_sleep.sql` | `sleep_idle_sessions`, `spawn_idle_session_sweeper` |
| handoffs | `20261024050000_collaboration_handoffs.sql` | `handoff_with`, MCP tool `handoff` |
| repo write policy | `20261024060000_collaboration_member_write_access.sql` | `plan_member_write`, `try_acquire_member_write`, `application::ensure_member_session_workspace`, host `member.setWriteAccess` |

* **Receipts**: `collaboration_space_deliveries.receipt_state` is `queued` →
  `processing` (set when the input is dispatched, by the trigger
  `collaboration_receipt_processing` on `conversation_inputs`, or directly
  when delivery dispatched immediately) → `replied` (the receiving seat posts
  in the same thread afterwards). It never moves backwards. Transport
  `status` (`queued|dispatched|failed`) is unchanged.
* **Origin**: `collaboration_space_messages.origin` is `user|agent`
  (backfilled from the envelope actor) and is returned with every message
  together with its receipts (user audience).
* **Group delivery**: each delivery prepends a
  `<missed_group_messages>` block with up to 30 thread messages after the
  member's `last_seen_message_id` (excluding its own posts). The window's
  lower bound is fixed per delivery (`context_from_seq`) so a retry sends
  identical text and dedupe keeps working. `space.wakePreview` /
  `preview_space_wake` return how many members a draft would wake (all agent
  seats for a draft without @, minus the sender) and how many are asleep.
* **Handoffs**: `{done, inputs_constraints, ask}`; depth = parent (latest
  accepted handoff received by the caller's seat in the thread) + 1, limit
  `VIBEX_HANDOFF_MAX_DEPTH` (3); accepted handoffs per initiating turn limit
  `VIBEX_HANDOFF_MAX_PER_TURN` (2). Over-limit → row `rejected` +
  `limit_exceeded`. Delivery failure → row `failed` and the initiator posts a
  report to User in the same thread. Replays by `operation_id` return the
  stored result.
* **Repo writes**: per member `write_access` (default `write_isolated`). The
  member's earliest session in a workspace keeps the checkout; any other
  session needs its own worktree, provisioned with the workflow
  `write_isolated` code. `write_serialized`: one busy writer per (member,
  workspace) lease; other sessions' deliveries are deferred
  (`write_serialized_busy`) and retried by the minute sweeper.
* **Sleep**: thread sessions idle for `VIBEX_MEMBER_IDLE_MINUTES` (30; 0
  disables) with no running turn and no queued input get `asleep_since`.
  Delivering to one is a wake recorded per originating turn (agent sender's
  active turn, else the message); over `VIBEX_MEMBER_WAKE_CAP` (3) the
  delivery is deferred (`wake_limit_exceeded`) and retried by the sweeper.

## Pre-existing test failures (identical on origin/master 442c61ab)

1. `agents` lib: `zcode::tests::an_old_path_node_does_not_hide_a_version_manager_node`
2. `agents` test `auth_mode_policy`: `qoder_has_only_subscription_and_keeps_the_personal_access_token`
3. `agents` test `auth_mode_policy`: `headless_account_tokens_stay_out_of_the_api_key_field`
4. `db` lib: `tests::legacy_automation_timezone_is_resolved_exactly_once` (the test's last query lacks `.bind(record.id)`)
5. `plugins` test `portable_package`: `monorepo_official_v2_plugins_in_plugins_dir_are_valid`
6. `plugins` test `portable_package`: `monorepo_plugins_bootstrap_offline_in_topological_order_and_cascade_dependents`
7. `plugins` test `shared_node_worker`: `tier0_and_tier1_plugins_enable_with_zero_worker_processes`
8. `plugins` test `sqlite_registry`: `runtime_artifacts_are_content_addressed_and_locks_are_package_scoped`
9. `server` test `headless_bootstrap`: `headless_agent_events_are_persisted_for_websocket_replay`
10. `server` test `web_domains`: `one_authenticated_application_surface_opens_product_domains_for_the_web_ui`
11. `vibex-mcp` bin: `tests::collaboration_opens_same_workspace_tools_without_session_control` (expected tool list predates the space-collection tools)

## Phase 4 — member memory

- **Activity (short-term).** On every completed reply the runtime records one
  line per turn into `member_activity` (`turn_id` unique, so retries are
  idempotent). The line comes from a pluggable `ActivitySummarizer`
  (`member_memory::set_activity_summarizer`). The default
  `FirstSentencesSummarizer` keeps the first 2 sentences, capped at 240 chars.
  Rows from `direct:` threads are flagged `private`.
- **Injection.** `persona_prompt_text_for_turn` appends a `[成员记忆]` block to
  the member identity context. The block holds the latest N cross-thread entries
  (`VIBEX_MEMBER_ACTIVITY_LIMIT`, default 8, 0 disables) and the BM25 top facts
  for the turn's prompt. In a group thread, private activity and private facts
  are left out entirely, with no placeholder.
- **Facts (long-term).** `member_facts` has scope `global`, `thread:<id>` or
  `private`, and origin `agent`, `user` or `distilled`. Full CRUD is in
  `member_memory`.
- **Distillation hook.** `FactDistiller` plus `distill_member_memory` and
  `spawn_memory_distiller`, with a per-member cursor in
  `member_memory_distill_state`. Facts distilled from private activity are
  always forced to `private`. No LLM distiller is wired by default.
- **Agent tools.** MCP `memory_search` and `memory_write` use underscores
  because MCP tool names reject dots. They are scoped to the calling member
  and thread. Writes default to the current thread. Writes in a private chat
  are forced to private. Writes to another thread's scope are rejected. The
  skill doc is `vibex-multi-agent/MEMORY.md`.
- **Host ops** (the user's view, which includes private items):
  - `collaboration/member.memory.list {memberId, scope?}`
  - `member.memory.update {memberId, factId, content?, scope?}`
  - `member.memory.delete {memberId, factId}`
  - `member.activity.list {memberId, limit?}`

### Known limitations (Phase 4)

- Chinese retrieval ranking is rough: BM25 runs over character unigrams and
  bigrams, with no word segmentation or embeddings.
- Long-term facts depend on agents calling `memory_write` (see `MEMORY.md`).
  Automatic distillation exists only as a hook, so it is future work.
