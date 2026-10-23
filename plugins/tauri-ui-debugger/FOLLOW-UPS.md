# TauriUI调试器 — host-side follow-ups

These problems were found while building the plugin. Each one lives in host code
that all plugins share, so the plugin branch does not change them. They are
listed here for a separate host PR.

## (a) Plugin config card is ~30px narrower than the tab bar

- Location: `frontend/src/styles/legacy/index.css`, around line 17622. The rule
  `.settings-page .dsh-detail-page .product-plugin-detail-body,
  .settings-page .dsh-detail-page .product-plugin-config-shell` gives **both**
  the outer detail body and the nested config shell
  `padding-inline-end: 20px; scrollbar-gutter: stable`.
- Effect: the end padding and the reserved scrollbar gutter are applied twice,
  so the config card ends about 30px short of the tab bar above it. This
  affects every plugin's config page.
- Proposed fix: drop `padding-inline-end` and `scrollbar-gutter` from the inner
  `.product-plugin-config-shell` and keep them only on the scrolling
  `.product-plugin-detail-body`.

## (b) Plugin list ignores manifest `interface.icon`

- Location: `PluginProductIcon` in `OfficialPluginIcon.tsx`. It only picks from
  `OFFICIAL_GLYPHS`, which is keyed by plugin id, and falls back to a generic
  glyph otherwise.
- Effect: a third-party or new plugin can't show its own icon even when its
  manifest declares `interface.icon`.
- Proposed fix: the host reads `interface.icon` from the manifest for every
  plugin (resolved against the plugin root, sanitized as SVG/PNG) and uses
  `OFFICIAL_GLYPHS` only as a fallback. This keeps ADR-0069 "no privilege"
  intact, with no id special-casing.

## (c) Backend conversation events with a `conversationId` are not filtered on the frontend

- The local `draft.insert` / `draft.target` handling in `PluginRuntimeLoader.ts`
  only covers calls *without* a `conversationId`; those go to the last-focused
  editable composer. Backend-originated draft events that *do* carry a
  `conversationId` are not filtered by conversation on the frontend, so they
  insert into whichever composer is active, even if it belongs to a different
  conversation.
- Proposed fix: the composer listener compares `event.conversationId` with its
  own conversation id and ignores events that don't match.

## (d) Stale `pnpm-lock.yaml` on master

- The lockfile on master is stale. A frozen install fails for 7 plugins'
  dependencies, so local verification needed an uncommitted lockfile/install
  workaround that is not part of this branch.
- Proposed fix: regenerate the lockfile on master (`pnpm install` with no
  frozen lockfile) in a dedicated commit, and turn on a CI frozen-lockfile check.

## (e) `plugin:no-privilege` probably doesn't cover this plugin

- `scripts/check-plugin-no-privilege.mjs` prints
  `仓库内没有官方插件包` for this repo layout. Its plugin discovery doesn't pick
  up `plugins/tauri-ui-debugger/` (or treats it as non-official), so the
  "official packages may only import the public SDK" import check is likely
  never applied to `app/main.js`. The plugin is import-free by design, so it
  would pass, but the check isn't actually guarding it.
- Proposed fix: extend discovery to the `plugins/*/.vibex-plugin/plugin.json`
  layout, and add a fixture test so an empty discovery result fails loudly.
