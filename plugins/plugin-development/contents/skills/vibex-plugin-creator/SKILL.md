---
name: vibex-plugin-creator
description: Author, test, and hot-reload VibeX v2 plugins using @vibex/plugin-sdk (defineVibeXPlugin, Registry<T>, ServiceContainer, beforeTurn, InternalMessageCapture, and 1-hop HostCapabilityBroker).
---

# VibeX Plugin Creator (v2 Architecture)

Use this skill when the user asks to create, extend, or hot-reload a VibeX plugin.

## Plugin Tiers

1. **Tier-0 (Declarative `plugin.json` + Markdown Skills)**:
   - No JavaScript or Node Worker required.
   - Declare `integrations` (`content.skill`, `provider.model.catalog`, `app.command`) in `.vibex-plugin/plugin.json`.
2. **Tier-1 (Single-file ESM `app/main.js`, Same-Tree React Rendering)**:
   - Set `"apiVersion": "2.0"` and `"entrypoints": { "app": { "entry": "app/main.js", "protocol": "2.0" } }`.
   - Export `defineVibeXPlugin({ id, activate(ctx) })`.
   - Components registered via `ctx.registerSlot`, `ctx.registerView`, or `ctx.registerSettingSection` render directly inside the Host React tree and share all Host React Contexts (`useTranslation`, `useTheme`, `useQueryClient`).
   - Call `await ctx.storage.kv.get/set`, `await ctx.network.fetch`, `await ctx.conversation.call` via the 1-hop `plugin_host_call` IPC bridge without spawning a Node Worker.
3. **Tier-2 (Full-Trust Background Worker)**:
   - Add `"entrypoints": { "worker": { "path": "worker/index.js", "runtime": "node", "protocol": "1.1" } }` only when long-lived background stdio/MCP servers are needed.

## Minimal Tier-1 Example (`app/main.js`)

```js
import { defineVibeXPlugin } from '@vibex/plugin-sdk';

export default defineVibeXPlugin({
  id: 'acme.hello',
  activate(ctx) {
    ctx.registerCommand({
      id: 'say-hello',
      title: 'Say Hello',
      async handler() {
        await ctx.storage.kv.set('lastGreeting', new Date().toISOString());
      },
    });
  },
});
```
