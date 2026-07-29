# Codeg Office Watch Adoption

## Source

- Project: Codeg
- Repository: sibling checkout `codeg`
- Pinned commit: `549add8d3ba07f31464c9cddde8ba7a7478eed14`
- License: Apache License 2.0
- Upstream files reviewed:
  - `src-tauri/src/office_watch/mod.rs`
  - `src-tauri/src/commands/office_tools.rs`
  - `src-tauri/src/web/handlers/office_watch_proxy.rs`

## VibeX targets and adaptations

- `crates/artifacts/src/office.rs`: retained the one-file/one-process,
  reference-count, readiness, process-limit, crash-recovery, explicit-close,
  and idle-reaping behavior behind `ArtifactToolProvider`.
- `crates/artifacts/src/adapters.rs`: moved child process and loopback TCP
  handling behind testable ports. The executable is an absolute path from
  `ToolInstallationLock`; PATH lookup and provider-owned installation were
  deliberately removed.
- `crates/artifacts/src/service.rs`: added Artifact revision records,
  provider selection, preview leases, per-lease capabilities, and Conversation
  event references.
- `src-tauri/src/office_runtime.rs` and
  `src-tauri/src/commands/office_tools.rs`: replaced the legacy global watch
  map and remote shell installer with a thin adapter over Artifact Service and
  Agent A's managed Tool Runtime.

The Codeg web proxy was studied for its security invariants. No Axum route was
ported in this slice. VibeX exposes only the lease data needed by a future web
proxy: Artifact id, provider id, watch key, loopback port, high-entropy
capability token, expiry, and reference count.

The resulting Rust is substantially reorganized for VibeX's ports-and-adapters
architecture and TDD seams. It is not a byte-identical vendor copy.

## Verification

- `cargo test -p artifacts`
- `cargo test -p artifacts --test local_adapters`
- `cargo test -p conversations artifact_revision_event_projects_reference_without_file_bytes`
- `cargo test -p vibex office`

## Apache-2.0 obligations

VibeX preserves the upstream license and attribution in
`THIRD_PARTY_NOTICES.md`. A complete copy of Apache License 2.0 is in
`docs/third-party/licenses/Apache-2.0.txt`. Modified files carry VibeX-specific
documentation and this adoption record identifies the changes.
