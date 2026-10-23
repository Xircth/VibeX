---
summary: Create, inspect, debug, and safely revise VibeX DAG Workflows from Agent conversations and editable file tabs.
---

# Workflow Creator

Author VibeX DAG workflows as real files, then validate, debug, and publish them without treating an in-memory graph as the source of truth.

Once enabled, three surfaces work together:

- the `vibex-workflow-creator` Skill, so an Agent can design a valid DAG;
- `vibex-workflow-mcp`, for read/write, validation, publish, run inspection, pause/continue, and debug runs;
- Workflow Studio, which opens `*.vibex-workflow.json` as an editable tab.

The source file is the authoring fact. Saving uses an artifact revision and refuses a stale overwrite. Publishing creates an immutable version. Automations stay on the version they already reference until you point them at a new one.

## Enable

This plugin ships with the Host, starts disabled, and cannot be uninstalled. Turn it on in Plugins. The first enable binds the Skill and MCP to compatible installed Agents. Later enable/disable cycles keep the selection you already made.

VibeX Desktop must be running. The Host starts a loopback-only command gateway, launches the MCP with the managed Node.js runtime, and injects a per-app-lifetime bearer token. That token is never stored in this package or in `config.json`.

## Edit a workflow

Create or open a `*.vibex-workflow.json` file in the project, or under `~/.vibex/workflows/`. The tab is Workflow Studio. Saving writes the source artifact; it does not publish a version and does not retarget Automations.

Model nodes as durable steps, not as “the Agent”. An Agent Step owns one child Conversation. Retries and continuation add Turns to that same Conversation. Encode order only through `dependsOn`. Do not create cycles.

## Debug and publish

Save and validate before any test.

- `workflow_debug_source` runs the current unpublished source through a hidden durable snapshot. It must not create a catalog version.
- `workflow_publish` creates an immutable visible version, and only when you ask for a release.
- `workflow_start` starts a published version against a real workspace.
- Pause stops active Turns without marking the run failed. Continue creates a new Turn in the same node Conversation.
- A derived debug run can reuse unchanged completed ancestors and rerun one node, or that node plus its downstream.

## Configuration

**Default Agent Step completion** chooses how a new Agent Step finishes if the source does not say otherwise:

- Manual: wait for confirmation after the step produces a candidate.
- Automatic: accept the candidate and continue downstream.

This is an authoring default. It does not rewrite steps that already declare a completion policy, and it does not change runs that already started.

## Offline and network

The editor and MCP stay on the machine. MCP traffic uses a random loopback port between the managed process and VibeX. Agent Steps follow the selected Agent and project network policy; the plugin does not add its own outbound access.

## Troubleshooting

- MCP says VibeX is unavailable: keep Desktop open and re-enable the plugin so the Host can inject a fresh token.
- Save conflict: the source changed outside the tab. Reload, reconcile, then save with the new revision.
- An Automation did not pick up edits: it is pinned to one published version. Publish, then point that Automation at the new version.
- Debug created a catalog version: stop. Source tests must use `workflow_debug_source`, not publish.
