# Full-trust plugin execution & HostCapabilityBroker

VibeX v4 treats installation and enablement as the user's decision to trust the complete package. Worker, App, Runtime, filesystem, process, and network behavior run with the same local rights as the Host. Per-capability grants are omitted. `packageClass=isolated` does not change Host spawn.

## Public boundary & capability grants

Full trust does not make internal APIs public. Import only the SDK, declare contributions and fine-grained capability grants (`grants` / `permissions`) in `.vibex-plugin/plugin.json`, and route product behavior through published Host slots and `HostCapabilityBroker` capabilities:

- **`storage.kv` (`get|put|set|delete|list|clear`)**: SQLite-backed persistent KV store isolated per plugin ID (with in-memory hot cache).
- **`storage.settings` (`get|put|set`)**: Reads and atomically writes the plugin's root `config.json` validated against `config.schema`.
- **`secret.keep` / `secrets` (`get|put|delete`)**: OS Keychain / encrypted secret storage scoped to the plugin ID and declared secret keys.
- **`fs.read` / `fs.write` & `files` (`read|write|stat|list`)**: File read/write, metadata stat, and directory listing within authorized roots (`workspace` / `plugin_data` / `$APP_DATA` / `$HOME`). Boundary enforcement uses **component-wise path prefix matching** (so granting `/dir/foo` never matches `/dir/foobar`) and immediately rejects any path containing `..` parent-directory traversal (`files_root_denied`).
- **`net.fetch` / `net.websocket` & `network.fetch` (`fetch`)**: Host-proxied HTTP/HTTPS and WebSocket requests restricted to declared origin patterns (`https://api.example.com`, `https://*.example.com`, `wss://...`). Boundary enforcement rejects URLs containing `@` userinfo credentials (e.g., `https://trusted.com@evil.com`) and blocks cloud metadata link-local addresses (`169.254.169.254` and `169.254.0.0/16`).
- **`env.read`**: Explicit environment variable key snapshot isolation—plugins only receive the snapshot of variable keys declared in `env.read`, never the Host's raw `process.env`.
- **`exec` (`run|spawn|kill|status`)**: Managed one-shot command execution (`run`) and long-lived background process/sidecar management (`spawn`, `kill`, `status`) with automatic cleanup on plugin deactivation.
- **`runtime.execute` / `runtime.lock` & `artifact.preview`**: Locked Runtime execution and loopback preview leases.
- **`conversation.*`, `events.*`, `app.notify.toast`**: Scoped conversation lifecycle control, event pub/sub, and Host toast notifications.

All manifest and grant validators must report **all** violations in a single pass (no fail-fast), so authors can fix every invalid grant or contribution in one iteration. This keeps plugins portable across Desktop and Server and prevents format/vendor special cases in core.

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
