# Headless Server Troubleshooting

## Authentication is rejected

- Confirm the credential is sent only as `Authorization: Bearer ...`, or as the
  WebSocket subprotocol token.
- A pairing secret expires after five minutes and is redeemable once. Create a
  new pairing rather than retrying an expired/redeemed secret.
- A revoked device is rejected on HTTP and disconnected from an existing
  WebSocket. Pair it again only after confirming the revocation was intended.
- The database stores hashes, so an existing token cannot be recovered.

Never paste a token into a URL, log bundle, screenshot, or issue.

## WebSocket reconnect/replay

Reconnect with the last confirmed Conversation sequence. Wait for `ready`,
apply snapshot/replay through the advertised high-water mark, then accept live
events. Ignore duplicate sequences. Preserve or ignore unknown event kinds;
do not make the cache unreadable. An offline cache is always read-only.

An oversized client frame is closed at 1 MiB. Split application work into
registered commands/events rather than increasing the frame limit.

## Automation does not run

- Only the host holding the data-directory Automation owner lease may tick.
- A second desktop/Server is expected to be passive until the owner exits.
- On takeover, orphaned running Runs become `interrupted` and are not resent.
- Legacy in-place Automations migrate disabled with
  `migration_required`; review workspace, branch, timezone, Agent and
  PluginAction before enabling.
- Shared-root Runs require a clean repository on the selected branch. The
  default worktree-per-run mode avoids that shared mutation boundary.

## Plugin or Tool cannot become ready

- Plugin enabled, dependency, Skill and Provider states are independent.
- A Tool distribution must use a public DNS HTTPS URL with no embedded
  credentials/query/fragment, exact version, supported platform, and valid
  SHA-256. Every resolved address must be public and redirects are rejected.
- Hash mismatch, path escape, or invalid installation lock fails before probe.
- Legacy `install_command` is evidence only and is never a repair mechanism.

## Office preview fails

- The executable must come from a live `ToolInstallationLock`; PATH lookup does
  not satisfy readiness.
- A preview lease must match the registered file, loopback port, capability and
  expiry. Closing/reaping the lease revokes replay.
- Symlink/path escape and unregistered ports fail closed.
- A crashed or readiness-timeout provider is reaped; opening again creates a
  replacement subject to the process limit.

## Safe diagnostics

Record stable error code, operation id, protocol/server version, capability
list, and redacted timing. Do not collect bearer/pairing/preview capabilities,
prompt content, local paths, raw manifests, or database copies without a
separate sanitization review.
