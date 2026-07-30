# Agent D Delegation Backend Verification

## Base and baseline

- Worktree branch: `codex/plugin-v2-tool-runtime`
- Rebased onto local `master`: `16d57232`
- Agent D starting SHA after the Agent A/B/C series was replayed:
  `2ae587f162af543d18acb6061ed1199e6e813d69`
- Pre-change baselines:
  - `cargo test -p delegation-proto`: 3 passed
  - `cargo test -p delegation`: 35 passed
  - `cargo test -p vibex-mcp`: 10 passed

## RED / GREEN log

Each RED was added through a public injector, framed companion, Broker, or
Conversation projection seam.

| Slice | RED observation | GREEN verification |
|---|---|---|
| Capability injection | `companion_injection_follows_capability` did not compile because the injector accepted Agent identity rather than capabilities | `cargo test -p vibex companion_injection_follows_capability --lib` |
| Token Conversation scope | Mismatched Conversation returned `running` | `cargo test -p delegation token_conversation_mismatch_is_rejected --lib` |
| Working root | `/outside` started a child for a `/work` token | `cargo test -p delegation requested_working_dir_cannot_escape_token_root --lib` |
| Mention schema | `tools/list` omitted AgentMention and `vibex://agent` semantics | `cargo test -p vibex-mcp tool_schema_explains_agent_mentions` |
| Parent teardown | Broker had no `parent_closed` seam; setup children were also missed | `cargo test -p delegation parent_closed_cascades_only_its_running_children --lib`; `parent_closed_during_setup_cancels_the_child` |
| First terminal | A late setup completion overwrote an earlier cancel | `cargo test -p delegation early_cancel_wins_over_later_setup_completion --lib` |
| Depth | Configured depth 9 was accepted | `cargo test -p delegation depth_limit_is_capped_at_eight --lib` |
| Parent isolation | Token A read token B's running task | `cargo test -p delegation token_cannot_read_another_parents_task --lib` |
| Durable lifecycle identity | Delegation events lacked parent Conversation and broker delegation id | `cargo test -p delegation lifecycle_events_reference_the_parent_conversation --lib` |
| Feedback | Listener returned a permanent empty stub | `cargo test -p delegation feedback_is_delivered_at_least_once_until_committed --lib` |
| Ask | In-memory feature service had no pending-question/answer seam | `cargo test -p delegation ask_blocks_until_a_structured_answer_arrives --lib` |
| Session info | `sessions` exposed no tool and listener had no resolver | `cargo test -p vibex-mcp session_info_feature_is_independent`; `cargo test -p delegation session_info_resolves_only_with_its_feature_service --lib` |

Fixed-point review added regression coverage for:

- scoped MCP external-handle cancellation, including cancel-before-call and a
  later setup send failure;
- canonical working-root validation that rejects symlink escape;
- listener-side token feature authorization and Conversation-bound ask answers;
- event-authoritative DB fallback instead of legacy `sessions.status`;
- teardown reconciliation after a lagged runtime event subscriber;
- `get_session_info.max_messages`, including metadata-only (`0`) behavior.
- Started-before-terminal lifecycle ordering and immediate setup-child teardown;
- one-at-a-time ask handling, parent teardown release, and live-session checks
  for every companion message;
- bounded pre-cancel/closed-parent tombstones and transcript folding before the
  message limit is applied.

Pre-existing behaviors were retained with named regression coverage:
`identical_parallel_tasks_keep_independent_task_ids`,
`completed_result_is_capped_at_256_kib`,
`cache_evicts_oldest_over_byte_cap`, and
`status_falls_back_to_db_for_evicted_task`.

## Persistence and platform evidence

- `cargo test -p conversations delegation_events_rebuild_child_binding`
  uses a temporary SQLite database, creates the child through the
  conversations service, checks parent/tool/delegation links, and compares the
  rebuilt timeline with the incremental projection.
- Unix UDS integration:
  `vibex-mcp::tests::call_broker_round_trips_over_uds`.
- Windows named-pipe integration is compiled and run on Windows:
  `vibex-mcp::tests::call_broker_round_trips_over_named_pipe`.
- Codeg provenance and Apache-2.0 obligations are recorded in
  `docs/third-party/codeg-adoption.md` and `THIRD_PARTY_NOTICES.md`.
