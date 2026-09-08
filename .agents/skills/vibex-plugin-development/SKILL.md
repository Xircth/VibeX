---
name: vibex-plugin-development
description: Build, migrate, test, link, debug, or package full-trust VibeX v4 product plugins with README summaries, contents, root config, dependencies, App surfaces, editable file tabs, Agent Skills, workflows, MCP, Workers, and Runtimes. Use for .vibex-plugin/plugin.json, @vibex/plugin-sdk, vibex-plugin CLI, or linked plugin development.
---

# VibeX Plugin Development

Build one user-facing product with one identity, README, root config, content tree, and lifecycle. App, Agent, Host, and Runtime are integration targets inside that product.

The Host product plugin (Skill `/create-skill` and contract references) lives in the git submodule `assets/plugins/plugin-development` (`https://github.com/Xircth/vibex-plugin-development`). Edit that repository for the user-facing Skill. This Skill is the in-tree authoring procedure against the checked-out SDK and CLI.

## Load the local contract

1. Run `python3 .agents/skills/vibex-plugin-development/scripts/locate_toolchain.py` from the VibeX repository root.
2. Read every path printed under `required`; stop when one is missing.
3. Use the checked-out SDK and CLI versions. Treat online examples as research, not as the active contract.
4. Read [references/workflow.md](references/workflow.md) for package composition and verification.
5. Read [references/full-trust.md](references/full-trust.md) when authoring executable Worker, App, Runtime, filesystem, network, or external-editor behavior.

Completion criterion: every integration used by the package exists in the local manifest type, validator, Host, and test harness.

## Compose the product

- Put the one-line `summary` in README frontmatter and the complete user guide in the README body.
- Put Agent/user-readable resources under `contents/` and index them in `.vibex-plugin/content.index.json`.
- Put mutable user settings in root `config.json`; describe them with `config.schema`.
- Put Runtime descriptors under `depends/`, source entrypoints under `runtime/`, and generated output under `dist/`.
- Declare every integration statically. A Skill is optional; at least one real integration is required.
- Use `file.opener + artifact.preview` for Runtime-backed read-only previews.
- Use `file.opener.editorSurface + app.surface(slot: artifact.editor)` for an editable UTF-8 file tab. Read and save through `bridge.artifact`; the App never needs a Host path.

Use only `@vibex/plugin-sdk`, `/worker`, `/app`, `/testing`, `/protocol`, and `/stdio`. If the public SDK cannot express the product, add a generic Host capability, expose it through the SDK, test it, and then consume it from the plugin.

## Develop against Full Trust

VibeX v4 executes installed plugin code with the user's trust. There is no permission grant step. Keep package identity, deterministic digest, candidate rollback, revision conflict handling, and lifecycle cleanup intact because they protect correctness and user data. Follow [references/full-trust.md](references/full-trust.md).

## Platform disciplines (ADR-0069)

- **No privileged official plugins.** Official plugins use the same public SDK, contribution points, and toolchain as any third party. Never special-case a plugin ID in Host code, and never reach for a private `host.call`, slot, or lifecycle. CI enforces this (`pnpm run plugin:no-privilege`): official packages import only the public SDK, and Host code carries no official-plugin-ID branches.
- **Single-layer extension.** A plugin targets Host contribution points only. Reuse another plugin by copying its source and republishing under a new Publisher + Plugin ID. The derived package installs, stores data, and updates independently. Same-slot coexistence is resolved by the Host.
- **A contribution point ships with its first official consumer.** New contribution kinds enter the stable surface only together with an official plugin consuming them plus the four acceptance items (CLI validate, Host inspect, real UI/Agent consumption, author docs). Build only against contribution points documented as stable; if a needed extension point is missing, stop at that boundary and deepen the public SDK first.

## Verify the real journey

Run from the plugin root:

```text
vibex plugin run server --http://127.0.0.1:17891 --token <token>
vibex-plugin init . --template host-chrome   # or provider-import / full / …
vibex plugin run build
vibex-plugin validate
vibex plugin run test
vibex plugin add --dev .
vibex plugin run dev
vibex plugin run test --host
vibex plugin pack
vibex plugin publish
```

`host-chrome` writes one contribution per chrome slot (`app.command` /
`app.toolbar` / `app.status` / `app.composer.slash` / `app.timeline.card` /
`app.settings.section`). `panel` / `kanban-view` write one structure surface
each with a Vite Module Federation remote. `provider-import` writes one
`provider.model.importSource`. Chrome slots refresh through the activation
generation. Structure remotes use `vibex plugin run dev` HMR (host `loadRemote`
points at Vite; leaving dev falls back to `dist/remoteEntry.js`).

`vibex-plugin test --host` against a chrome or structure package: install →
enable → declared kinds appear in `plugin_contribution_catalog` → disable →
they vanish → enable again → uninstall, source directory kept. A Skill-bearing
package still also reloads `SKILL.md`.

Prefer `vibex plugin run server` then `vibex plugin run dev` from the plugin
directory. `add --dev` only links. `vibex-plugin install --link` is an alias
of that Host import when it still exists.

The product CLI also exposes `vibex plugin pack` and `vibex plugin publish`.

When developing VibeX itself, build the local CLI and use `npx-cli`
(`vibex plugin …`). Verify a real linked install and `run dev` against the
running Host; harness-only success is insufficient for App mounting, file
editing, Runtime processes, or remote behavior.

## Completion gate

- The plugin imports only public SDK modules and contains no VibeX-source special case.
- Manifest, SDK, CLI validation, Host parsing, and UI consumption agree on every contribution.
- Worker and App harnesses cover registration, load, save, conflict/error, dispose, and candidate rollback paths that apply.
- Build, validate, test, doctor, and deterministic pack pass.
- A real linked package activates, its user-visible function works end to end, and uninstall/data-retention behavior is documented.
- README explains requirements, operation, offline/network behavior, troubleshooting, and third-party licenses.

When a required extension point is absent, stop plugin implementation at that boundary and deepen the public SDK first.
