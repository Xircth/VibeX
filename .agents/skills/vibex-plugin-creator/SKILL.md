---
name: vibex-plugin-creator
description: Create, test, and hot-reload VibeX v2.0 plugins across all 4 progressive complexity tiers (Tier 0 JSON/CSS, Tier 1 UI/Hook TS/React, Tier 2 Shared Node Worker, Tier 3 Sidecar/Daemon) with Cordis-style IoC services, beforeTurn implicit prompt injection, and InternalMessageCapture side-channels. Use when the user asks to create a VibeX plugin, customize the UI/theme/toolbar/panels/markdown, hook into agent turns, or extend VibeX capabilities.
---

# VibeX Next-Gen Plugin Creator (`apiVersion: "2.0"`)

Before authoring or modifying a plugin, read [`references/sdk-api.md`](./references/sdk-api.md) (generated directly from `packages/plugin-sdk/src/*.ts` via `node scripts/gen-plugin-sdk-doc.mjs`).

## 1. Choose the Simplest Tier That Solves the Task

VibeX uses a **4-Tier Progressive Complexity Model**. Never spawn a backend Worker if Tier 0 or Tier 1 suffices:

1. **Tier 0 — Pure Declarative (`.vibex-plugin/plugin.json` + optional `style.css` / `skills/*/SKILL.md`)**
   - Best for: Custom themes (`themes`), CSS variable overrides, JSON Schema settings (`settingsSchema`), static slash commands (`slashCommands`), prompt templates, and MCP server declarations.
   - Runtime cost: **0 JS, 0 child processes**.
2. **Tier 1 — In-Process UI & Hook Plugin (`.vibex-plugin/plugin.json` + `index.js` / `index.ts`)**
   - Best for: UI slot items (`toolbar.actions`, `statusbar.items`, `composer.actions`, `timeline.card`, `global.overlay`), custom panels/tabs/kanban views, custom Markdown codeblock renderers (`ctx.ui.registerMarkdownRenderer`), `beforeTurn` / `afterTurn` hooks, `captureInternalMessage` side-channels, Cordis-style IoC service providers/consumers (`ctx.services.provide` / `ctx.services.inject`), and 1-hop Rust Host capability calls (`ctx.host.storage.kv`, `ctx.host.http.fetch`, `ctx.host.exec`, `ctx.host.conversation`, `ctx.host.browser`).
   - Runtime cost: **0 child processes** (isolated inside `PluginErrorBoundary` + reversible `EffectScope`).
3. **Tier 2 — Shared Node Worker (`.vibex-plugin/plugin.json` + `worker/index.mjs`)**
   - Best for: Background Node.js computation (`fs`, `crypto`, parsing) that does not require native C++ addons.
   - Set `"entrypoints": { "worker": { "path": "worker/index.mjs", "sharedWorker": true } }` (default for Node workers). Runs inside VibeX's shared single Node Worker Host via `vm.SourceTextModule` + `AbortController` + `AsyncLocalStorage`.
4. **Tier 3 — Dedicated Process / Sidecar Daemon**
   - Best for: Native addons, custom Python/binary runtimes, or long-lived sidecar daemons via `ctx.host.exec.spawn`.
   - Set `"entrypoints": { "worker": { "path": "worker/index.mjs", "isolation": "process" } }`.

---

## 2. Instant Hot-Reload Directory (`~/.vibex/plugins/<plugin-id>`)

VibeX watches `~/.vibex/plugins/` (or `$VIBEX_USER_PLUGINS_DIR`) with a `200ms` debounce:
- Creating `~/.vibex/plugins/<plugin-id>/.vibex-plugin/plugin.json` automatically discovers, imports, and enables the plugin in `< 1s` without restarting VibeX.
- Modifying any file inside `~/.vibex/plugins/<plugin-id>/` automatically increments the plugin's `generation`, disposes the previous `EffectScope` (removing old UI slots, hooks, and CSS), and activates the updated module in `< 1s`.

---

## 3. Minimal Templates by Tier

### 3.1 Tier 0: Declarative Theme + Slash Command (`.vibex-plugin/plugin.json`)

```json
{
  "apiVersion": "2.0",
  "id": "ocean-breeze",
  "name": "Ocean Breeze Theme & Commands",
  "version": "0.1.0",
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
  ],
  "slashCommands": [
    {
      "name": "review-arch",
      "description": "Review module boundaries and coupling",
      "prompt": "Review the current workspace changes for deep-module boundaries and hidden coupling."
    }
  ],
  "settingsSchema": {
    "type": "object",
    "properties": {
      "strictMode": {
        "type": "boolean",
        "title": "Strict Architecture Review",
        "default": true
      }
    }
  }
}
```

### 3.2 Tier 1: UI + `beforeTurn` Implicit Context + `InternalMessageCapture` (`index.ts`)

Create `.vibex-plugin/plugin.json`:
```json
{
  "apiVersion": "2.0",
  "id": "token-guard",
  "name": "Token Guard & Risk Monitor",
  "version": "0.1.0",
  "main": "index.js",
  "permissions": ["storage"]
}
```

Create `index.js` (or compile from `index.ts`):
```ts
import { defineVibeXPlugin } from '@vibex/plugin-sdk';

export default defineVibeXPlugin((ctx) => {
  // 1. Implicitly inject instructions into the Agent prompt (hidden from user chat bubble)
  ctx.hooks.beforeTurn(async () => ({
    label: 'Token Guard Protocol',
    priority: 10,
    content:
      'At the end of your reply, emit <!--vibex-internal:token-guard:summary {"risk":"low","summary":"..."}-->',
  }));

  // 2. Capture and strip the internal side-channel payload from the Assistant stream
  ctx.hooks.captureInternalMessage('token-guard:summary', async (msg) => {
    await ctx.host.storage.kv.set('lastSummary', msg.parsedPayload as Record<string, string>);
    await ctx.host.ui.notify({
      title: 'Token Guard',
      message: `Captured risk report: ${JSON.stringify(msg.parsedPayload)}`,
      variant: 'info',
    });
  });

  // 3. React to turn completion
  ctx.hooks.afterTurn(async (event) => {
    await ctx.host.storage.kv.set('lastTurnStatus', event);
  });

  // 4. Register a custom Markdown codeblock renderer
  ctx.ui.registerMarkdownRenderer({
    id: 'risk-matrix',
    language: 'risk-matrix',
    render: ({ code }) => `Risk Matrix: ${code}`,
  });
});
```

### 3.3 Cordis-Style IoC Service Sharing & Decorator Interception

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

## 4. Verification & Self-Test Checklist

1. **Unit-Test with `createPluginTestHarness`**:
   ```ts
   import { createPluginTestHarness } from '@vibex/plugin-sdk';
   import myPlugin from './index';

   const harness = createPluginTestHarness({ pluginId: 'my-plugin' });
   await harness.activate(myPlugin);
   // Assert slots, commands, hooks, or hostCalls
   await harness.dispose();
   expect(harness.getSlots()).toHaveLength(0); // Zero residue
   ```
2. **SDK Documentation Sync Check**:
   Whenever `packages/plugin-sdk/src/*.ts` changes, run:
   ```bash
   node scripts/gen-plugin-sdk-doc.mjs
   node scripts/gen-plugin-sdk-doc.mjs --check
   ```
