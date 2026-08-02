# Artifact/Office Backend TDD and Migration Record

## Scope

This branch implements the backend portions of T1.8–T1.10. It does not add an
Artifact web route, Office watch proxy, or frontend page.

## RED/GREEN

1. T1.8 RED: `records_only_content_changes` failed because the `artifacts`
   crate and `ArtifactService.record` API did not exist.
2. T1.8 GREEN: A/A/B content produces revisions 1/2 only; producer/plugin/
   provider/tool-lock evidence is retained and file bytes are absent from
   events.
3. T1.9 RED: `office_preview_reuses_watch_process` failed because provider,
   resolved-tool, lease, process, TCP, and clock ports did not exist.
4. T1.9 GREEN: one file shares one process; exact installation-lock paths,
   ref-counted leases, capability data, readiness, crash recovery, limits,
   cancellation-safe cleanup, and idle reaping are observable through
   `ArtifactService.open_preview/close_preview`.
5. Conversation RED: `artifact_service` was rejected by the stable event
   source CHECK constraint.
6. Conversation GREEN: Artifact events use the existing `host` source and
   stable `artifact_*` event kinds.
7. Durability RED: an injected event append failure left a committed revision
   without a retryable Conversation reference.
8. Durability GREEN: revision plus event outbox are committed in one SQLite
   transaction; retrying the same hash drains the idempotent pending event
   without creating another revision.
9. Cancellation RED: aborting `open_preview` while OfficeCLI waited for its
   readiness announcement left the spawned process alive.
10. Cancellation GREEN: a pending-process drop guard terminates the child on
    timeout, error, or future cancellation.
11. Historical-lock RED: preview resolution only followed `current.json`, so
    an Artifact pinned to a retained older version became unavailable after an
    upgrade.
12. Historical-lock GREEN: the resolver loads the exact version lock, verifies
    its serialized lock identity and binary digest, and holds a Tool Runtime
    lease until the preview closes or is reaped.
13. Reap/close RED: a shared provider report could be consumed by the wrong
    ArtifactService, and a failed process termination made close non-retryable.
14. Reap/close GREEN: reports are broadcast to canonical and compatibility
    lease owners, terminal events remain pending until delivered, and provider
    state is committed only after termination succeeds.

## Migration

- Removed the global `src-tauri/src/office_watch.rs` process map.
- Removed PATH/known-global-path detection and remote shell/PowerShell
  installation from `commands/office_tools.rs`.
- Existing Tauri command names and `OfficeWatchStartResult` remain as a
  compatibility adapter for `OfficePreview`; DOCX still receives
  `NOT_INSTALLED` and keeps its existing fallback.
- OfficeCLI is installed under VibeX's managed tool root from a version-locked
  manifest. Downloaded bytes are SHA-256 verified and probed before the current
  lock is committed.
- Artifact revisions are stored in `artifact_revisions`; content remains on
  the filesystem. `artifact_event_outbox` makes the revision/event boundary
  crash-retryable without storing file bytes.
- `artifact_preview_event_outbox` gives opened/closed/failed preview lifecycle
  references the same crash-retryable delivery guarantee. Reap reports first
  stage every owned terminal event, then finalize independently so one failed
  projection cannot discard the rest of a consumed provider report.
- The bundled `vibex.office` manifest and all three VibeX-authored Skill
  sources are compile-time embedded; its six actions cover PPTX create/modify,
  DOCX create/modify, and XLSX analyze/generate. Managed installation enables
  the PluginService through real tool/skill/provider readiness adapters;
  action resolution is gated on a Ready snapshot.
- Uninstall first drains both preview services, disables the plugin, releases
  plugin/runtime leases, and then uses Tool Runtime's lease-aware uninstall.

## Stable public API

- `ArtifactService::record`
- `ArtifactService::open_preview`
- `ArtifactService::close_preview`
- `ArtifactService::reap_previews`
- `ArtifactService::apply_reap_report`
- `ArtifactService::flush_pending_revision_events`
- `ArtifactService::flush_pending_preview_events`
- `ArtifactService::shutdown_previews`
- `ArtifactToolProvider`
- `ArtifactProviderDescriptor` / `ArtifactProviderProbe`
- `PreviewProviderRegistry`
- `ToolInstallationResolver`
- `ResolvedToolInstallation`
- `PreviewLease`
- `ToolRuntime::lease_installed` / `ToolRuntime::uninstall`
- `OfficeRuntime::resolve_bundled_action`
