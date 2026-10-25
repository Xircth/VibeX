---
name: vibex-plugin-creator
description: Create, test, and hot-reload VibeX v2.0 plugins across all 4 progressive complexity tiers (Tier 0 JSON/CSS, Tier 1 UI/Hook TS/React, Tier 2 Shared Node Worker, Tier 3 Sidecar/Daemon) with Cordis-style IoC services, beforeTurn implicit prompt injection, and InternalMessageCapture side-channels. Use when the user asks to create a VibeX plugin, customize the UI/theme/toolbar/panels/markdown, hook into agent turns, or extend VibeX capabilities.
---

# VibeX Plugin Creator (`manifestVersion: 4`, `apiVersion: "2.0"`)

Use this skill when creating, extending, testing, or hot-reloading a VibeX v2.0 plugin with `@vibex/plugin-sdk`. When working inside the VibeX repository, also consult `.agents/skills/vibex-plugin-creator/references/sdk-api.md` for full TypeScript signatures.

---

## 1. 4-Tier Progressive Complexity Model

Always choose the simplest tier that solves the user's problem. Never spawn a backend Worker if Tier 0 or Tier 1 suffices:

1. **Tier 0 — Declarative Configuration / Themes / Skills (`.vibex-plugin/plugin.json` + optional `style.css` / `contents/skills/*/SKILL.md`)**
   - Best for: Custom themes (`themes`), CSS variable overrides, JSON Schema settings (`config.schema` / `settingsSchema`), static slash commands (`slashCommands` / `app.composer.slash`), Agent skills (`content.skill`), provider catalogs (`provider.model.catalog`), and MCP server declarations (`content.mcp`).
   - Runtime cost: **0 JS, 0 child processes**.
2. **Tier 1 — In-Host UI & Hook Extension (`app/main.js`, `protocol: "2.0"`)**
   - Set `"entrypoints": { "app": { "entry": "app/main.js", "protocol": "2.0" } }` in `.vibex-plugin/plugin.json`.
   - Export `defineVibeXPlugin((ctx) => { ... })` from `app/main.js`.
   - Best for: Same-tree React UI slots (`ctx.ui.registerSlot`, `ctx.ui.registerToolbarItem`, `ctx.ui.registerStatusBarItem`, `ctx.ui.registerCommand`, `ctx.ui.registerSlashCommand`), custom panels/tabs/kanban views/settings sections (`ctx.ui.registerPanel`, `ctx.ui.registerTab`, `ctx.ui.registerKanbanView`, `ctx.ui.registerSettingsSection`), custom Markdown codeblock renderers (`ctx.ui.registerMarkdownRenderer`), turn hooks (`ctx.hooks.beforeTurn`, `ctx.hooks.afterTurn`), `ctx.hooks.captureInternalMessage` side-channels, Cordis-style IoC services (`ctx.services.provide`, `ctx.services.inject`, `ctx.services.intercept`), and 1-hop Rust `HostCapabilityBroker` RPC (`ctx.host.storage.kv`, `ctx.host.storage.settings`, `ctx.host.network.fetch`, `ctx.host.exec`, `ctx.host.conversation`, `ctx.host.ui.notify`).
   - Runtime cost: **0 child processes** (renders directly in the Host React tree inside `PluginErrorBoundary` + reversible `EffectScope`).
3. **Tier 2 — Shared Node Worker (`dist/worker.mjs` or `worker/index.mjs`, `"sharedWorker": true`)**
   - Add `"entrypoints": { "worker": { "path": "dist/worker.mjs", "runtime": "node", "protocol": "1.1", "sharedWorker": true } }`.
   - Best for: Background Node.js computation (`fs`, `crypto`, parsing, data pipelines) that does not require native C++ addons. Runs inside VibeX's shared single Node Worker Host via `vm.SourceTextModule` + `AbortController` + `AsyncLocalStorage`.
4. **Tier 3 — Isolated Process Worker / Native Runtime (`"isolation": "process"` or `"runtime": "native" | "python"`)**
   - Set `"entrypoints": { "worker": { "path": "dist/worker.mjs", "runtime": "node", "protocol": "1.1", "isolation": "process" } }`, use `"runtime": "python" | "native"`, or spawn managed sidecar daemons via `ctx.host.exec.spawn` / `depends/runtimes/*.json`.
   - Best for: Native addons, custom Python/binary runtimes, or heavy isolated background daemons.

---

## 2. Required v4 `.vibex-plugin/plugin.json` Skeleton

Every on-disk `.vibex-plugin/plugin.json` **must** include the complete v4 base skeleton fields so that `vibex-plugin validate` passes without errors:

- `manifestVersion: 4`
- `apiVersion: "2.0"`
- `publisher`: lowercase publisher ID (`^[a-z0-9][a-z0-9._-]{0,62}$`)
- `id`: plugin ID (`^[a-z0-9][a-z0-9._-]{1,62}$`)
- `name`: human-readable display name
- `version`: semver string (e.g. `"0.1.0"`)
- `readme: "README.md"` (root `README.md` must exist and begin with YAML frontmatter containing a single-line `summary` $\le$ 200 chars)
- `content: { "root": "contents", "index": ".vibex-plugin/content.index.json" }` (`.vibex-plugin/content.index.json` must exist with `{ "schemaVersion": 1, "items": [...] }`)
- `config: { "schema": { "type": "object", "properties": {}, "additionalProperties": false } }` (root `config.json` must exist, e.g. `{}`)
- `engines: { "vibex": ">=0.1.3 <1.0.0", "pluginSdk": "^2.0.0" }`
- `entrypoints.app: { "entry": "app/main.js", "protocol": "2.0" }` (required for Tier 1+ in-host UI/Hook plugins; never use legacy root `"main": "index.js"`)
- `integrations`: array of declared Host integrations (at least one integration entry such as `app.command`, `app.composer.slash`, `content.skill`, etc.)

---

## 3. Namespaced SDK API Convention

Always use the **namespaced APIs** on `VibeXPluginContext` (`ctx`):

- **`ctx.ui.*`**: `ctx.ui.registerSlot`, `ctx.ui.registerCommand`, `ctx.ui.registerSlashCommand`, `ctx.ui.registerComposerSlash`, `ctx.ui.registerComposerAction`, `ctx.ui.registerToolbarItem`, `ctx.ui.registerStatusBarItem`, `ctx.ui.registerPanel`, `ctx.ui.registerTab`, `ctx.ui.registerKanbanView`, `ctx.ui.registerSettingsPage`, `ctx.ui.registerSettingsSection`, `ctx.ui.registerMarkdownRenderer`, `ctx.ui.registerConversationMode`, `ctx.ui.registerTimelineCard`, `ctx.ui.registerOverlay`, `ctx.ui.registerContextMenu`
- **`ctx.hooks.*`**: `ctx.hooks.beforeTurn`, `ctx.hooks.afterTurn`, `ctx.hooks.onRuntimeEvent`, `ctx.hooks.captureInternalMessage`, `ctx.hooks.intercept`
- **`ctx.services.*`**: `ctx.services.provide`, `ctx.services.inject`, `ctx.services.require`, `ctx.services.intercept`, `ctx.services.onChange`
- **`ctx.host.*`**: `ctx.host.storage.kv.{get,set,put,delete,list,clear}`, `ctx.host.storage.settings.{get,set,put}`, `ctx.host.network.fetch` (or `ctx.host.http.fetch`), `ctx.host.exec.{run,spawn,kill,status}`, `ctx.host.conversation.call`, `ctx.host.browser.call`, `ctx.host.ui.notify` (or `ctx.host.notify.toast`)

> **Compatibility Note**: Flat top-level methods (`ctx.registerCommand`, `ctx.registerSlot`, `ctx.provideService`, `ctx.storage.kv.*`, `ctx.network.fetch`, etc.) are retained strictly as backward-compatibility aliases. **All new plugin code and examples must exclusively use the namespaced APIs (`ctx.ui.*`, `ctx.hooks.*`, `ctx.services.*`, `ctx.host.*`).**

---

## 4. Instant Hot-Reload Directory (`~/.vibex/plugins/<plugin-id>`)

VibeX watches `~/.vibex/plugins/` (or `$VIBEX_USER_PLUGINS_DIR`) with a `200ms` debounce:
- Creating `~/.vibex/plugins/<plugin-id>/.vibex-plugin/plugin.json` automatically discovers, imports, and enables the plugin in `< 1s` without restarting VibeX.
- Modifying any file inside `~/.vibex/plugins/<plugin-id>/` automatically increments the plugin's `generation`, disposes the previous `EffectScope` (removing old UI slots, hooks, services, and CSS), and activates the updated module in `< 1s`.

---

## 5. Standard Templates by Tier

### 5.1 Tier 0: Declarative Theme + Slash Command (`.vibex-plugin/plugin.json`)

Ensure `README.md` (with `summary` frontmatter), `config.json` (`{}`), and `.vibex-plugin/content.index.json` (`{ "schemaVersion": 1, "items": [] }`) exist alongside `.vibex-plugin/plugin.json`:

```json
{
  "$schema": "https://schemas.vibex.dev/plugin/v4/plugin.schema.json",
  "manifestVersion": 4,
  "apiVersion": "2.0",
  "publisher": "acme",
  "id": "ocean-breeze",
  "name": "Ocean Breeze Theme & Commands",
  "version": "0.1.0",
  "readme": "README.md",
  "engines": {
    "vibex": ">=0.1.3 <1.0.0",
    "pluginSdk": "^2.0.0"
  },
  "content": {
    "root": "contents",
    "index": ".vibex-plugin/content.index.json"
  },
  "config": {
    "schema": {
      "type": "object",
      "properties": {
        "strictMode": {
          "type": "boolean",
          "title": "Strict Architecture Review",
          "default": true
        }
      },
      "additionalProperties": false
    }
  },
  "integrations": [
    {
      "id": "review-arch",
      "kind": "app.composer.slash",
      "command": "review-arch",
      "title": "Review Architecture",
      "description": "Review module boundaries and coupling",
      "prompt": "Review the current workspace changes for deep-module boundaries and hidden coupling."
    }
  ],
  "themes": [
    {
      "id": "ocean-dark",
      "label": "Ocean Dark",
      "scheme": "dark",
      "cssVariables": {
        "--background": "210 35% 9%",
        "--foreground": "200 20% 96%",
        "--primary": "192 90% 48%"
      }
    }
  ]
}
```

### 5.2 Tier 1: In-Host UI + `beforeTurn` Implicit Context + `InternalMessageCapture` (`app/main.js`)

Create `.vibex-plugin/plugin.json`:

```json
{
  "$schema": "https://schemas.vibex.dev/plugin/v4/plugin.schema.json",
  "manifestVersion": 4,
  "apiVersion": "2.0",
  "publisher": "acme",
  "id": "token-guard",
  "name": "Token Guard & Risk Monitor",
  "version": "0.1.0",
  "readme": "README.md",
  "engines": {
    "vibex": ">=0.1.3 <1.0.0",
    "pluginSdk": "^2.0.0"
  },
  "content": {
    "root": "contents",
    "index": ".vibex-plugin/content.index.json"
  },
  "config": {
    "schema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "entrypoints": {
    "app": {
      "entry": "app/main.js",
      "protocol": "2.0"
    }
  },
  "integrations": [
    {
      "id": "token-guard-status",
      "kind": "app.command",
      "title": "Show Token Guard Status",
      "handler": "showStatus"
    }
  ]
}
```

Create `app/main.js`:

```js
import { defineVibeXPlugin } from '@vibex/plugin-sdk';

export default defineVibeXPlugin({
  id: 'acme.token-guard',
  activate(ctx) {
    // 1. Register a command palette action via ctx.ui.*
    ctx.ui.registerCommand({
      id: 'show-status',
      title: 'Show Token Guard Status',
      category: 'Security',
      async handler() {
        const lastSummary = await ctx.host.storage.kv.get('lastSummary');
        await ctx.host.ui.notify({
          title: 'Token Guard',
          message: lastSummary
            ? `Last summary: ${JSON.stringify(lastSummary)}`
            : 'No risk summary recorded yet.',
          variant: 'info',
        });
      },
    });

    // 2. Implicitly inject instructions into the Agent prompt (hidden from user chat bubble)
    ctx.hooks.beforeTurn(async () => ({
      label: 'Token Guard Protocol',
      priority: 10,
      content:
        'At the end of your reply, emit <!--vibex-internal:token-guard:summary {"risk":"low","summary":"..."}-->',
    }));

    // 3. Capture and strip the internal side-channel payload from the Assistant stream
    ctx.hooks.captureInternalMessage('token-guard:summary', async (msg) => {
      await ctx.host.storage.kv.set('lastSummary', msg.parsedPayload);
      await ctx.host.ui.notify({
        title: 'Token Guard',
        message: `Captured risk report: ${JSON.stringify(msg.parsedPayload)}`,
        variant: 'info',
      });
    });

    // 4. React to turn completion
    ctx.hooks.afterTurn(async (event) => {
      await ctx.host.storage.kv.set('lastTurnStatus', event);
    });

    // 5. Register a custom Markdown codeblock renderer
    ctx.ui.registerMarkdownRenderer({
      id: 'risk-matrix',
      language: 'risk-matrix',
      render: ({ code }) => `Risk Matrix: ${code}`,
    });
  },
});
```

### 5.3 Cordis-Style IoC Service Sharing & Decorator Interception

```ts
import { createServiceKey, defineVibeXPlugin } from '@vibex/plugin-sdk';

export interface MetricsService {
  record(event: string): string;
}

export const MetricsServiceKey = createServiceKey<MetricsService>('metrics.service');

export const providerPlugin = defineVibeXPlugin((ctx) => {
  ctx.services.provide(MetricsServiceKey, {
    record: (event) => `recorded:${event}`,
  });
});

export const consumerPlugin = defineVibeXPlugin((ctx) => {
  // Re-runs automatically when MetricsServiceKey is provided/updated, and cleans up when withdrawn
  ctx.services.inject([MetricsServiceKey], ([metrics]) => {
    metrics.record('consumer-ready');
  });
});
```

---

## 6. Verification & Self-Test Checklist

1. **Validate Package Contract with CLI**:
   ```bash
   vibex-plugin validate <plugin-dir>
   ```
   Ensure `.vibex-plugin/plugin.json`, `README.md`, `config.json`, and `.vibex-plugin/content.index.json` pass validation with `valid: true`.
2. **Unit-Test with `createPluginTestHarness`**:
   ```ts
   import { createPluginTestHarness } from '@vibex/plugin-sdk';
   import myPlugin from '../app/main.js';

   const harness = createPluginTestHarness({ pluginId: 'acme.token-guard' });
   await harness.activate(myPlugin);
   // Assert slots, commands, hooks, or hostCalls
   await harness.dispose();
   expect(harness.getSlots()).toHaveLength(0); // Zero residue
   ```
3. **SDK Documentation Sync Check** (when modifying `packages/plugin-sdk/src/*.ts`):
   ```bash
   node scripts/gen-plugin-sdk-doc.mjs
   node scripts/gen-plugin-sdk-doc.mjs --check
   ```
