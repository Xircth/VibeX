# Open ACP Registry Agent Management — Release Evidence

Date: 2026-07-30 (CST)

## Outcome

The Agent management cutover is complete:

- Agent identity is open (`AgentId`) across management, sessions,
  conversations, delegation, and Runtime launch.
- Claude Code, Codex, OpenCode, and Pi Agent are declarative Built-in Profiles.
  Their special treatment is limited to default membership, ordering, icons,
  proactive local detection, and richer declared native Runtime configuration.
- Built-in and Registry Agents use the same membership, install lock,
  preflight, operation, lifecycle, configuration, and session-gate pipeline.
- The Settings Agent bar is flat, keeps the `+` action last, and retains
  delisted, unauthenticated, damaged, disabled, and repairable members.
- Registry install plans always resolve an independent local Runtime and ACP
  launch plan. An adapter cannot silently select its bundled Runtime.
- Binary archives require SHA-256 verification. Package distributions lock the
  exact package version and ecosystem integrity evidence.
- Native configuration writes only Profile-declared understood fields across
  official JSON/TOML files and preserves unknown data. Account state is
  display-only; browser and CLI login flows are absent.

## Automated gates

The following commands passed against the final source state:

```text
cargo fmt --all
pnpm run generate-types
pnpm run generate-types:check
pnpm run prepare-db
pnpm run prepare-db:check
pnpm run check
pnpm run lint
cargo test --workspace
pnpm --dir frontend exec vitest run src/features/agent-management src/pages/settings
git diff --check
```

The focused Settings suite passed 8 files / 10 tests. The full Rust workspace
suite passed, including 212 `agents` unit tests, all management integration
tests, 113 `vibex` tests, and the affected API, DB, conversation, delegation,
executor, local-deployment, and service crates.

The closed-management static gate has no matches:

```text
rg 'AgentKind::ALL|DEFAULT_AGENT_SETTINGS|SELECTABLE_AGENTS|AgentConfigManager' \
  crates src-tauri frontend/src
```

The obsolete Codex adapter variable also has no matches:

```text
rg 'CODEX_CLI_PATH' \
  crates src-tauri frontend/src \
  docs/specs/acp-native-agent-platform/07-open-agent-registry-management
```

## Scenario evidence

| Required scenario | Evidence |
| --- | --- |
| Fresh install and open identity | `management_fixture`, `install_planner`, `install_orchestrator`, and `session_identity` integration tests |
| Existing DB migration | DB tests for evidence-only membership migration, stable ordering, generic IDs, and read-only OpenClaw/Hermes history |
| Offline cached Registry | Registry cache tests cover 24-hour freshness, ETag refresh, offline last-valid fallback, invalid refresh retention, and offline-empty state |
| Built-in external detection | Probe tests adopt only fully verified Profile candidates; real local Claude Code, Codex, and OpenCode probes passed |
| Generic add/install | Store/UI tests cover optimistic insertion and selection; real npx and Binary Registry distributions passed ACP initialization |
| Cancel/failure/interrupt | Orchestrator tests preserve membership and last valid lock and cover two-job, per-Agent, and shared-resource limits |
| Repair/update/rollback | Planner/orchestrator tests cover staged switch, version evidence, explicit repair, update, and rollback |
| Active-process destructive block | Lifecycle test covers ACP process, in-flight turn, queued/running operation, external ownership, and shared Runtime; exact message is asserted |
| Disabled/not-ready session rejection | Session-gate tests cover disabled, needs-auth, needs-repair, unsupported, retired, stale option, and rebind cases |
| Native configuration conflict and preservation | Native-config tests cover exact multi-file JSON/TOML previews, typed fields, official provider credential shapes, unknown-field preservation, field revisions, credential masking, staged removal, and next-session-only effect |
| Delisted/retired visibility | Registry and management projection tests keep membership independent of Registry presence |

These are deterministic process/HTTP/filesystem/time-boundary tests, not mocks
of the management domain or repositories.

## Real ACP handshakes

The ignored release probe in
`crates/agents/tests/real_acp_probe.rs` spawns an absolute executable and sends a
real ACP `initialize` request through the production ACP SDK. It rejects missing
agent metadata. A configurable timeout is available only for cold package
installation; the default remains 20 seconds.

| Agent / distribution | Runtime and ACP binding | Result |
| --- | --- | --- |
| Claude Code Built-in | `claude` 2.1.211 + `claude-agent-acp` 0.59.0; exact Runtime injected with `CLAUDE_CODE_EXECUTABLE` | Passed |
| Codex Built-in | `codex` 0.145.0 + `codex-acp` 1.1.4; exact Runtime injected with `CODEX_PATH` | Passed |
| OpenCode Built-in | `opencode acp` 1.18.2 | Passed |
| Pi Agent Built-in | isolated `@earendil-works/pi-coding-agent` 0.82.1 + `pi-acp` 0.0.32; managed Runtime `.bin` first in `PATH` | Passed |
| Gemini CLI, generic npx | exact `@google/gemini-cli@0.53.0`, Registry args `--acp`, absolute managed `.bin` | Passed (`gemini-cli` 0.53.0) |
| Harn, generic Binary | Registry archive for macOS arm64 0.10.42, Registry SHA-256 `4029d2993ea96c2985c8f1136eda7c133c2d662bb7ebab5a41e1af2d30e1bab6`, args `serve acp` | Hash matched; passed (`harn` 0.10.42) |

The Codex probe initially exposed that `codex-acp` otherwise selects its bundled
Codex package. The Profile/runtime launch contract was corrected to bind the
separate local Runtime explicitly. Equivalent binding is applied during both
external detection and managed installation.

### Current upstream uvx evidence

The official Registry currently contains two uvx entries. Both were tested with
their exact declared version in isolated uv caches:

- `fast-agent-acp==0.9.26 -x` exits with
  `ModuleNotFoundError: No module named 'fast_agent_acp'`.
- `minion-code@0.1.44 acp` exits because its published dependency set cannot
  import `AuthMethod` from `acp.schema`.

Therefore uvx planning, locking, invocation, cancellation, and failure
retention are covered by deterministic tests, but no current official uvx entry
can honestly be recorded as a successful live handshake. The failure remains a
typed install/diagnostic result; VibeX does not fall back to another
distribution or weaken verification.

## Visual and accessibility evidence

The desktop bundle compiled and launched, and its WebView established the Vite
connection. Because the local capture environment did not reliably composite
the GPU/WebKit layer, final screenshots were captured from the same Vite build
in headless Chromium with only the Tauri IPC/event boundary replaced by
deterministic release data. No console or page errors occurred.

- [Agent detail, light](agent-settings-visual.png)
- [Agent detail, dark](agent-settings-dark-visual.png)
- [ACP Registry, installed tab](agent-registry-installed-visual.png)

The render verifies the flat five-Agent bar, four Built-in Profiles first,
generic Agent insertion in the same bar, fixed final `+`, status marks,
account/API/not-logged-in projections, local Runtime and ACP versions,
Profile-declared structured native configuration, Registry tabs, and independent
installed-list ordering. Component tests additionally verify keyboard/button
reorder, focus semantics, disabled overlays, search, uninstalled sorting,
add-and-install selection, cached refresh, unsupported rows, and Toast errors.

## Temporary artifacts

All isolated Pi, Gemini, Binary, uvx, and Chromium validation directories were
moved to the macOS Trash after the probes. No validation package was added to
the project dependency graph.
