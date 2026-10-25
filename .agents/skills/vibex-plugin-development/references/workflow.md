# VibeX plugin authoring workflow

## Contract order

Read and reconcile these sources before authoring:

1. `packages/plugin-sdk/src/manifest.ts` and `packages/plugin-sdk/src/context.ts`
2. `packages/plugin-sdk/src/protocol.ts`, `worker.ts`, `app.ts`, and `testing.ts`
3. `packages/plugin-cli/src/validation.ts`, `build.ts`, `scaffold.ts`, and CLI `--help`
4. `docs/plugins/package-v4.md` and `docs/plugins/sdk-and-cli.md`
5. Host parsing and `crates/plugins/src/host_capability_broker.rs` when verifying capability behavior

## App entrypoint protocols (`2.0` vs `1.0`)

`entrypoints.app` in `.vibex-plugin/plugin.json` supports two distinct protocols:

1. **`protocol: "2.0"` — In-Host / Federated Module App**
   - Manifest shape: `{ "entry": "app/main.js", "protocol": "2.0", "styles"?: "style.css" }` (with `apiVersion: "2.0"`).
   - Authoring API: `defineVibeXPlugin((ctx) => ...)` from `@vibex/plugin-sdk`.
   - Always use namespaced methods on `ctx`: `ctx.ui.*`, `ctx.hooks.*`, `ctx.services.*`, `ctx.host.*` (flat top-level methods are legacy compatibility aliases only).
   - Renders inside the Host React tree (`PluginErrorBoundary` + reversible `EffectScope`) and calls `HostCapabilityBroker` over 1-hop RPC without spawning a Node Worker.
2. **`protocol: "1.0"` — Standalone HTML Surface App**
   - Manifest shape: `{ "root": "dist/app", "document": "index.html", "protocol": "1.0" }` (built from `runtime/app.mjs` + `runtime/app.html`).
   - Authoring API: `definePluginApp(({ root, bridge, signal }) => ...)` from `@vibex/plugin-sdk/app`.
   - Mounts an isolated HTML document for `app.surface` (`slot: "plugin.detail.panel"` or `slot: "artifact.editor"`), communicating with the Host and Worker via `bridge.invoke`, `bridge.artifact`, and `bridge.ready()`.

## Worker protocol & frame limits

- Worker entrypoints use `protocol: "1.1"` (`initialize` → `activate` → `invoke` / `ping` / `dispose`).
- Default single-frame limit is **`32 MiB`**, configurable from `1..128 MiB` via `entrypoints.worker.maxFrameMiB`.
- Logical message limit is **`64 MiB`**; payloads exceeding a single frame are automatically split and reassembled across `frame.chunk` envelopes.

## Package composition

Start with README, root `config.json` (described by `config.schema` in `plugin.json`), and one end-user outcome. Add only integrations required by that outcome:

- `content.skill`: Agent knowledge and repeatable operating instructions.
- `content.mcp`: MCP configuration stored as package content.
- `workflow.binding`: structured repeatable work.
- `file.opener -> previewProvider`: Runtime-backed read-only preview. The `file-tab` template produces this plus a detail panel.
- `file.opener -> editorSurface`: App-backed editable UTF-8 file tab. The `editor-tab` template produces this.
- `app.surface(slot: plugin.detail.panel)`: UI inside plugin details.
- `app.surface(slot: artifact.editor)`: full file-tab editor with `bridge.artifact`.
- `artifact.preview`: managed external preview process.
- `app.command` / `app.toolbar` / `app.status` / `app.composer.slash` / `app.timeline.card` / `app.settings.section`: chrome slots. The `host-chrome` template writes one of each.
- `app.panel` / `app.tab` / `app.kanban.view` / `app.settings.page`: structure surfaces with optional Module Federation remotes. The `panel` and `kanban-view` templates write Vite remotes.
- `provider.model.importSource`: Model Provider import menu. The `provider-import` template writes one.
- `provider.model.catalog`: Static no-secret provider preset catalog (`resource` JSON).
- `provider.remote.provisioner`: Host-owned remote provision kind such as `ssh`.
- `host.service`: periodic Worker handler.

Typed references must resolve inside the same package. A file opener declares exactly one `previewProvider` or `editorSurface`; an editor target must reference an `artifact.editor` surface. Validation rejects missing, ambiguous, or wrong-slot references. `dependencies.kind` is `runtime` only.

Agent-side contributions apply after a new or rebound session. UI and Provider contributions appear on enable and vanish on disable.

## Editable file-tab flow

1. Declare the extension/media type on `file.opener` and set `editorSurface`.
2. Declare an `app.surface` with `slot: artifact.editor`, App entrypoint `app`, and handler `surface.createSession`.
3. Register `surface.createSession` in the Worker.
4. In the App, require `bridge.artifact`, call `readText()`, and retain its revision.
5. Save with `writeText(content, expectedRevision)`. Surface an actionable reload choice on a revision conflict.
6. Keep editor-specific protocol code inside the plugin; the Host remains format-agnostic.

## Lifecycle and fixtures

Keep candidate execution content-addressed. Validate Worker registrations and dependency readiness before publication. Publish one generation, retain the previous generation on failure, drain old leases, and dispose boundedly.

Prefer `vibex plugin run server` then `vibex plugin run dev` from the plugin directory. `add --dev` only links. Chrome slots refresh through the activation generation. Structure remotes use Vite HMR while `run dev` is active.

In declarative or non-Worker tests, read the real `.vibex-plugin/plugin.json` directly from disk rather than replacing it with a static fixture export. Cover declarative-only, in-host App (`createPluginTestHarness`), Worker (`createWorkerHarness`), standalone App panel (`createAppHarness`), chrome slots, structure surfaces, editable file tab, and complete-product cases.

## Reference package rule

Reference plugins consume only public SDK contracts. Core code may know contribution kinds and Host slots; it must not know plugin IDs, vendors, or file-format-specific behavior.
