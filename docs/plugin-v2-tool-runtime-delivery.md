# Plugin v2 and Tool Runtime delivery

## Scope and base

- Worktree: `.worktrees/plugin-v2-tool-runtime`
- Branch: `codex/plugin-v2-tool-runtime`
- Base: `285bd941a3f9595ada151c3efa08e3a4d56648ac` (`master`)
- Scope: T1.1–T1.6 only. Artifact Provider, Office watch, and frontend work are
  intentionally excluded.

The requested ADR-0030–0033/platform-expansion integration branch was not
available locally or on the configured remote. The user explicitly authorized
continuing from the latest `master`; those documents were used as the design
input but were not copied into this branch.

## Stable public API

`plugins` owns the manifest and plugin lifecycle boundary:

- `PluginService::import_manifest(json, source)`
- `PluginService::enable(plugin_id)`
- `PluginService::snapshot(plugin_id)`
- `ToolDependencyResolver::resolve(dependency)`
- `ToolRuntimePort` and the production `ToolRuntimeAdapter`

`tool-runtime` owns verified tool installation and leases:

- `ToolRuntime::ensure(request, cancellation)`
- `ToolRuntime::upgrade(request, cancellation)`
- `ToolRuntime::release(lease)`
- `ToolInstallationLock`, `InstallationAttempt`, and `ToolLease`
- `HttpDownloader`, `LocalToolFilesystem`, `CommandProcessProbe`, and
  `FileInstallationLockStore`

Stable error codes used by these seams include:

- `plugin_manifest_invalid`
- `plugin_manifest_major_unsupported`
- `plugin_provider_unknown`
- `tool_platform_unsupported`
- `tool_version_not_exact`
- `tool_digest_mismatch`
- `tool_probe_failed`
- `tool_install_cancelled`
- `tool_lease_invalid`

## Security and state model

- Manifest `$schema` must be exactly `vibex-plugin/v2`; unknown fields fail
  closed.
- A manifest's `builtin` claim is ignored. Membership comes from the trusted
  import source.
- Tool versions must be exact SemVer values and platform selection is an exact,
  deterministic target-triple lookup.
- Downloads enter a unique staging attempt, are SHA-256 verified, and only then
  reach an absolute-path probe. No shell or `PATH` lookup is used.
- A successful install is moved into
  `{managed_root}/{tool}/versions/{version}` before the per-version lock and
  atomic `current.json` pointer are committed.
- Cancellation and failures remove staging only. Upgrade does not alter the
  previous current pointer until the new version has passed verification and
  probe.
- Installs for the same tool are serialized. Current, one rollback version, and
  versions with active leases are retained.
- Membership, activation, dependency, skill, and provider states are separate.
  Readiness is derived and is never persisted as another source of truth.

## v1 migration

Migration `20260729100000_plugin_v2_runtime.sql` creates separate v2 registry,
activation, dependency, skill, and provider tables plus
`plugin_legacy_evidence`.

`PluginV1Migration::migrate_all` serializes the complete original v1 row,
including `install_command`, into evidence. The adapter deliberately has no
process/executor dependency. Ordinary and unknown rows become
`migration_required`. Only the three fixed VibeX builtin UUIDs have explicit
stable-id mappings, and those mappings are inserted disabled.

The legacy Tauri `plugin_install_skill` endpoint now captures migration evidence
and returns a failed `plugin_migration_required` state. It never interprets or
executes `install_command`.

## RED/GREEN record

| Task | RED evidence | GREEN verification |
| --- | --- | --- |
| T1.1 | `cargo test -p plugins import_office_action_manifest`: package missing, then unresolved public seam (exit 101) | Office action import and unknown-major tests pass |
| T1.2 | `resolves_exact_tool_distribution`: resolver types missing (exit 101) | exact macOS arm64 resolution, unsupported platform, and floating-version rejection pass |
| T1.3 | `cargo test -p tool-runtime rejects_digest_mismatch_before_probe`: package/public seam missing (exit 101) | digest mismatch leaves probe count at zero and no current lock |
| T1.4 | `upgrade_is_atomic`: `upgrade` missing; concurrent ensure downloaded twice; `release` missing | cancellation/probe failure preserve v1, success switches v2, one concurrent attempt, lease-delayed cleanup |
| T1.5 | `enabling_builtin_resolves_dependencies`: readiness and runtime port types missing (exit 101) | enabled/operation/dependency/skill/provider/readiness states pass for success and failure |
| T1.6 | `plugin_v1_migration_never_executes_command`: migration API missing (exit 101) | evidence retained, marker command never runs, and only known builtins map disabled |
| PLG-001/002 | optional metadata fields missing; unknown provider import succeeded | optional metadata/console imports and unknown provider fails closed |
| PLG-004 | lock source/time fields missing | persistent version lock records URL and installation time |

No Codeg source was copied or adapted, so the Codeg adoption/Apache-2.0
attribution inventory does not require an update.
