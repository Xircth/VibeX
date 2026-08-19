---
summary: Create, inspect, debug, and safely revise VibeX DAG Workflows from Agent conversations and editable file tabs.
---

# VibeX Workflow Creator

Workflow Creator adds three connected capabilities:

- the `vibex-workflow-creator` Skill for designing valid DAGs;
- a dedicated MCP server for validation, publication, Run inspection, checkpoints, node conversations, and derived debug Runs;
- a visual editor for `*.vibex-workflow.json` files in VibeX tabs.

The Workflow source file remains the authoring source of truth. Saving uses an artifact revision and refuses stale overwrites. Publishing creates an immutable version; existing Automation references do not move until explicitly updated.

## Requirements

VibeX Desktop must be running. The Host starts a loopback-only `vibex-server` command gateway, launches the MCP with its managed Node.js runtime, and injects a per-app-lifetime bearer token. The token is never stored in this package or `config.json`.

The Skill and MCP are bound to all compatible installed Agents on first enable. Change the selection from this plugin’s settings or Settings → MCP. Later enable/disable cycles preserve an existing selection.

## Debugging model

A node Conversation may contain multiple immutable Turns. Stopping a node pauses only its active Turn; continuing creates a new Turn in the same Conversation. Pausing the DAG stops every active Turn without marking the Run failed. A source test uses an unpublished durable debug snapshot, so it never creates a catalog version or retargets an Automation. A derived debug Run reuses unchanged completed ancestors and reruns the selected node alone or with its transitive downstream.

## Offline and data flow

The editor itself is local and requires no network. Agent Steps may use network access according to the selected Agent and project policy. MCP traffic stays on a random loopback port between the managed MCP process and VibeX.

## Troubleshooting

- If MCP tools report that VibeX is unavailable, keep Desktop open and re-enable the plugin.
- A save conflict means the source changed outside the tab; reload, reconcile, and save again.
- A Workflow Automation is pinned to one published version. Publish and apply a new version to move that Automation.

## Third-party notices

This package uses the VibeX Plugin SDK, the official Model Context Protocol TypeScript SDK v2,
and the Host-managed Node.js runtime.
