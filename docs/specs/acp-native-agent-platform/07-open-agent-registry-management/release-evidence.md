# ACP Agent Platform Hardening — Release Evidence

Date: 2026-07-30 (CST)
Decision source: ADR-0034

## Outcome

ADR-0034 Phases 0–8 are implemented:

- every launch resolves a current immutable Installation lock and verifies all
  executable component hashes before spawn;
- install/update/repair operations have durable identities, frozen plans,
  host/resource leases, interruption recovery, offline repair, and bounded
  redacted diagnostics;
- the production management projection uses one reducer and keeps membership,
  installation, authentication, enabled state, and active operation orthogonal;
- Registry cache freshness, delisting retention, explicit update confirmation,
  search/disclosure, and stale/offline mutation gates are enforced;
- native JSON/TOML configuration is revision-aware and multi-file rollback is
  atomic; session defaults retain only values currently advertised by the
  exact ACP session;
- `auth/status` uses the negotiated official draft adapter and preserves
  supported, unsupported, malformed, timeout, and AuthRequired evidence;
- capability catalogs are fingerprinted with a monotonic authentication
  observation generation, generation-guarded, TTL-bounded, and refreshed
  through short-lived connections that are reaped;
- additional directories, session list/import/delete/resume/info updates,
  bounded `_meta`, usage cost, HTTP/SSE MCP, and lossless
  audio/resource/resource-link blocks are capability-driven;
- ACP session identity remains distinct from VibeX Conversation identity;
- Agent-specific Runtime/config facts remain declarative Profiles. Session
  config ordering, delegation MCP, and prompt enhancement no longer branch on
  Agent names;
- management probe facts use typed columns. Legacy `detail_json` is imported
  once by migration and no longer participates in business decisions;
- application-core authentication/probe coordination lives in
  `services::services::agent_management`; Tauri handlers map inputs/errors.

## Traceability

| ADR concern | Primary implementation evidence |
| --- | --- |
| Launch integrity and zero-spawn tamper gate | `launch_gate.rs`, `launch_gate_integrity.rs` |
| Persistent operations and resource leases | migrations `20260730010000`, DB management tests, install orchestrator tests |
| Typed probe migration and authentication observation generation | migrations `20260730020000` / `20260730030000`, `agent_probe_business_facts_have_typed_columns`, `legacy_agent_probe_json_is_imported_once_into_typed_facts`, capability fingerprint tests |
| One lifecycle reducer | `management_state.rs`, `AgentManagementApplicationService` |
| Registry freshness/offline/delist | `registry_cache.rs`, management repository and Registry UI tests |
| Native config transaction/conflict | `native_config.rs`, native-config and settings UI tests |
| Auth/capability truth | `auth_status.rs`, `capability.rs`, ACP fixture tests |
| ACP session extensions | manager/runtime fixture tests and SessionCreationForm tests |
| No static Agent control fallback | `TerminalProfileControls` locked-session test and capability normalization test |

## Automated gates

All commands below passed against the final source state:

```text
cargo fmt --all --check
pnpm run generate-types
pnpm run generate-types:check
pnpm run prepare-db
pnpm run prepare-db:check
pnpm run check
pnpm run lint
pnpm --dir frontend test -- --run
cargo test --workspace
```

Results:

- frontend: 189 files, 947 tests passed;
- Rust workspace: all non-ignored unit, integration, and doc tests passed;
- `agents`: 232 unit tests plus all deterministic ACP/management fixtures;
- `vibex`: 124 passed, 3 live-network tests ignored in the default run and
  executed separately below;
- generated TypeScript and SQLx offline metadata checks are current;
- Clippy passed for the whole workspace, all targets, `qa-mode`, with warnings
  denied.

The frontend run emitted pre-existing React `act(...)` and React Router future
flag warnings; it had no failed tests. No assertion or lint rule was weakened.

## Real ACP and Registry smoke

The release probe spawns an absolute executable, sends a real ACP
`initialize`, and never sends a prompt or prints credentials.

| Target | Exact execution | Result |
| --- | --- | --- |
| Claude Code Built-in | local `claude-agent-acp` 0.59.0 with absolute `CLAUDE_CODE_EXECUTABLE` | Passed |
| Codex Built-in | local `codex-acp` 1.1.4 with absolute `CODEX_PATH` | Passed |
| OpenCode Built-in / Binary | absolute `opencode acp` 1.18.2 | Passed |
| Pi Built-in | absolute `npx -y pi-acp@0.0.32` | Passed |
| Grok Build / npx | isolated install of `@xai-official/grok@0.2.115`, `grok agent stdio`, production handshake verifier | Passed |
| uvx resolution | isolated `fast-agent-acp==0.9.27` and `minion-code@0.1.44` | Passed |
| uvx ACP handshake | isolated `fast-agent-acp==0.9.27 -x` | Passed |
| Official ACP Registry | live official endpoint and public-catalog schema | Passed |

The unrelated Grok executable already on the user's PATH completed
`initialize` but omitted optional `agentInfo`, so the stricter generic release
probe rejected that local version. The repository-locked Grok 0.2.115 passed
the product handshake gate and is the release-relevant result.

## Scenario evidence

| Required scenario | Result and evidence |
| --- | --- |
| Four Built-in Agents | Real initialize passed for Claude Code, Codex, OpenCode, and Pi |
| Binary / npx / uvx | Real results above |
| Post-install tamper | Deterministic real-file SHA mutation test verifies zero spawn and needs-repair projection |
| Registry offline/stale/upgrade/delist | Deterministic HTTP/clock + SQLite repository/UI tests; live official Registry also passed |
| auth/status supported/unsupported/timeout/method-not-found/conflict | ACP subprocess fixtures and reducer tests passed |
| Repeated probe resource cleanup | prepared-session and short-lived connection discard tests verify removal from active runtime state |
| Four install interruption points | Durable recovery is covered by SQLite old-host Running-operation fixtures and staged-operation invariants; a destructive live app kill at staging/download/verified/pre-switch was **not run** against the user's real app data |

The last row is intentionally not described as a live pass. Reproducing it
requires a disposable VibeX application-data directory plus a process-kill
harness; using the user's active data would violate the task's data-safety
constraints. The deterministic substitute verifies that restart marks the old
operation Interrupted, releases Agent/resource leases, retains membership and
the previous current/rollback locks, retains the frozen plan, and allows an
explicit retry.

## Data and security

- No API key, token, complete environment, or unredacted diagnostic output is
  present in migrations, fixtures, capability snapshots, or this report.
- `shared/types.ts` and SQLx metadata were generated by project scripts, not
  edited by hand.
- No branch, commit, push, package dependency, or permanent validation
  directory was created for this work.
