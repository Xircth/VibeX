# Plugin update end-to-end verification

Date: 2026-11-13. Platform: Windows, real `vibex-server.exe`, production
React assets, Tabbit Chromium, and the public `npx-cli/bin/cli.js` entry.
The Host used an isolated data directory and loopback HTTP marketplace.
No application commands or browser network responses were mocked.

[Confirmed UI upgrade screenshot](plugin-updates-confirmed-2026-11-13.png)

## Verified journeys

| Journey                  | Observed result                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Background detection     | Host requested version/artifact endpoints without a UI check and persisted available versions.                                            |
| Update preview           | UI displayed identity, source/tag, version change, package digest, release notes, and Worker capability.                                  |
| Cancel                   | Installed version remained 1.0.0.                                                                                                         |
| Confirm in UI            | Enabled plugin changed from 1.0.0 to 2.0.0; enabled state and custom config remained intact.                                              |
| CLI without confirmation | Noninteractive update exited 1 and requested `--yes`; no update occurred.                                                                 |
| CLI with `--yes`         | Disabled plugin changed to 2.0.0 and stayed disabled; custom config remained intact.                                                      |
| Invalid checksum         | Host rejected the archive with `plugin archive checksum mismatch`.                                                                        |
| Worker startup failure   | UI showed `worker_closed`; old 1.0.0 remained enabled, unquarantined, and rendered its status contribution.                               |
| Registry outage          | Check reported HTTP 503 while retaining the last available version and successful timestamp.                                              |
| Host restart             | Version, source lock, config, activation, and cached availability survived with the registry offline.                                     |
| Notification             | New versions produced a toast and status count; its action opened `/plugins`.                                                             |
| Public GitHub install    | CLI cloned and installed `Xircth/vibex-plugin-provider-switch`, retained its source SHA and GitHub source lock, and checked successfully. |

## Defects found during execution

1. The standalone debug Host overflowed the default Tokio worker stack on
   plugin import. Its runtime now matches the desktop's 16 MiB worker stack.
   A regression starts the real executable and imports, previews, confirms,
   and reads a plugin through authenticated HTTP.
2. Host restart reset event sequences, while the browser retained its old
   cursor. Web reconnection now resets process-local Host event cursors and
   preserves durable subscription cursors. A test delivers both a lower
   sequence snapshot and a lower sequence notification after reconnect.

## Automated checks

- `cargo test -p server --test plugin_updates -- --nocapture`: 2 passed.
- `cargo test -p plugins --test plugin_updates -- --nocapture`: 5 passed,
  including marketplace archives, GitHub releases, stable GitHub tags,
  identity/config rejection, and failed activation retaining the old version.
- Frontend transport tests: 7 passed.
- Plugin catalog and update dialog tests: 32 passed.
- Production frontend build, scoped ESLint/Prettier, and server Clippy passed.

## Scope and limits

Marketplace upgrades used deterministic local HTTP releases, including real
ZIP download, checksum/content verification, disk replacement, and activation.
GitHub release/tag upgrade success used the existing HTTP protocol fixtures.
The public GitHub repositories inspected had no stable tags/releases, so this
run cannot claim a successful upgrade between two public GitHub releases.
Public GitHub installation and the no-update result were exercised live.

This run exercised the production Web client and shared Host update pipeline;
it did not exercise the packaged Tauri WebView or a release-mode installer.
Toast notifications are live-only; clients connecting after discovery recover
availability through the persistent status badge rather than replaying toasts.
Refreshing the Web page required reconnecting because credentials are held
in memory; reconnecting preserved the Host's plugin settings.

The optional repository testing skills referenced by `CONTEXT.md`
(`webapp-testing`, `e2e-testing-patterns`, `rust-testing`, and
`testing-tauri-apps`) were unavailable locally. Verification used the existing
Host integration patterns, Tabbit browser skill, and TDD workflow instead.
