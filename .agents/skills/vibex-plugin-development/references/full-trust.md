# Full-trust plugin execution & HostCapabilityBroker

VibeX v4 treats installation and enablement as the user's decision to trust the complete package. Worker, App, Runtime, filesystem, process, and network behavior run with the same local rights as the Host. Per-capability grants are omitted. `packageClass=isolated` does not change Host spawn.

## Public boundary

Full trust does not make internal APIs public. Import only the SDK, declare contributions in the manifest, and route product behavior through published Host slots and `HostCapabilityBroker` capabilities:

- **`storage.kv` (`get|put|set|delete|list|clear`)**: SQLite-backed persistent KV store isolated per plugin ID (with in-memory hot cache).
- **`storage.settings` (`get|put|set`)**: Reads and atomically writes the plugin's root `config.json` validated against `config.schema`.
- **`secrets` (`get|put|delete`)**: OS Keychain / encrypted secret storage scoped to the plugin ID.
- **`files` (`read|write|stat|list`)**: File read/write, metadata stat, and directory listing within authorized roots (`workspace` / `plugin_data`), rejecting path traversal or unauthorized roots with `files_root_denied`.
- **`network.fetch` (`fetch`)**: Host-proxied HTTP/HTTPS requests supporting custom method, headers, body, and timeout.
- **`exec` (`run|spawn|kill|status`)**: Managed one-shot command execution (`run`) and long-lived background process/sidecar management (`spawn`, `kill`, `status`) with automatic cleanup on plugin deactivation.
- **`runtime.execute` / `runtime.lock` & `artifact.preview`**: Locked Runtime execution and loopback preview leases.
- **`conversation.*`, `events.*`, `app.notify.toast`**: Scoped conversation lifecycle control, event pub/sub, and Host toast notifications.

This keeps plugins portable across Desktop and Server and prevents format/vendor special cases in core.

## Integrity and lifecycle

- Build a deterministic package and bind activation to its digest.
- Execute the immutable candidate, then publish the same bytes.
- Preserve the previous generation when candidate validation, activation, settings migration, or dependency readiness fails.
- Bind App and Runtime sessions to a generation; revoke them on disable, replacement, expiry, or unmount.
- Dispose listeners, timers, processes, MessagePorts, and temporary files.

## User data

- Use Host artifact sessions for editable file tabs. The Host owns the canonical path.
- Read a revision before editing and provide that revision on save.
- Treat revision conflicts as a normal recoverable state; never silently overwrite an external edit.
- Use atomic replacement for completed writes and keep file formats valid after every save.

## External services and native code

Pin or document every external editor, Runtime, executable, and network endpoint. Make offline behavior and data flow explicit in README. Validate messages from third-party frames before applying them to user data. Keep third-party notices and license terms inside the package.
