# Platform Capability v2 Release and Rollback

## Release contents

This release brings Plugin/Tool Runtime v2, Artifact/Office provider leases,
Delegation companion and `&Agent`, Automation v2, shared Application Core,
headless `vibex-server`, Web/Remote Desktop transports, device pairing, and
versioned remote protocol artifacts through one set of domain seams.

It does not add an iOS/Android application, APNs/FCM delivery, automatic
merge/push/publish/deploy, or a public Axum bypass around Application Core.

## Pre-release gate

Run the commands and record exact results in
`docs/verification/agent-k-release-hardening.md`. In particular, schema and DB
generated checks must be clean, all Rust/frontend tests must pass serially,
the production Web E2E must use built static assets, and the release Server
package smoke must not expose its supplied token. Run
`pnpm run dependency:licenses`; CI additionally runs RustSec and the pnpm
high-severity advisory gate.

Create a release tag only from a clean integration commit. Archive protocol
`docs/protocol/v1`, third-party notices, migration/security reports and the
exact base/release SHAs with the build.

## Rollout

1. Stop desktop and Server hosts for each data directory.
2. Capture a complete consistent backup, including SQLite WAL/SHM, managed Tool
   directories and Artifact files.
3. Deploy the desktop and `vibex-server` binaries plus matching Web static tree.
4. Start one host and verify health, authentication, protocol compatibility,
   migration evidence, Automation owner/reconciliation, retention cleanup and
   a read-only replay.
5. Review legacy Plugin/Automation drafts before enabling.
6. Expand to additional hosts only after confirming the first owner is stable.

## Rollback triggers

Rollback for migration checksum errors, missing evidence, unexpected external
process execution, token/capability leakage, replay gaps, duplicate terminal
events, duplicate Automation Runs, or a Run that remains running after startup
reconciliation.

## Rollback procedure

1. Stop every process touching the data directory.
2. Preserve the failed upgraded directory for diagnosis; do not edit it.
3. Restore the complete pre-upgrade snapshot as a unit.
4. Deploy the prior matching desktop, Server and Web assets.
5. Start one owner and verify Conversation sequences and Automation state.
6. Revoke any device/Server credentials suspected of exposure and pair anew.

Do not attempt to down-migrate by deleting tables or copying selected rows.
Managed Tool versions can be garbage-collected only after active leases are
released; never replace an installation lock with PATH discovery.
