---
name: vibex-workflow-creator
description: Design, edit, validate, publish, inspect, and debug VibeX *.vibex-workflow.json DAGs with the dedicated vibex-workflow-mcp.
---

# VibeX Workflow Creator

Use this Skill when the user asks to create or change a VibeX Workflow. The source artifact is the fact. An in-memory graph, a Studio screenshot, or a conversation outline is not.

## Source artifact

1. Find or create exactly one `*.vibex-workflow.json` file, either project-relative or below `~/.vibex/workflows/`.
2. Read an existing artifact with `workflow_source_read` before editing and keep its revision.
3. Save with `workflow_source_write` and that revision. On conflict, read again and reconcile. Never overwrite blindly.

## Graph rules

- Model nodes as durable steps, not as Agents. An Agent Step owns one child Conversation; retries and continuation add Turns to that same Conversation.
- Give every step a stable kebab-case ID. Encode ordering only through `dependsOn`. Never create a cycle or reference a missing step.
- Use `inputBindings` and JSON Pointers for data flow.
- `outputSchema` is an example embedded into the initial prompt. It does not validate or block the final Assistant text. Downstream steps receive that text even when it is not valid JSON.
- Select `executorProfileId`, `modeOverride`, and `configOverrides` from the Agent's native session controls. Do not invent Workflow-specific permission modes.
- Omit scheduling metadata unless the user asks for a workspace-isolation strategy. Use `completionPolicy: manual` only when the user wants a confirmation gate after the Agent Step.

## Debug versus publish

Save and validate before any test.

- `workflow_debug_source` tests the current unpublished source through a hidden durable snapshot. It must not publish a version or retarget an Automation.
- Later attempts pass `parentRunId`. Use `node` to isolate one node, or `downstream` to keep unchanged completed ancestors and rerun the selected branch.
- `workflow_publish` creates an immutable visible version, and only when the user asks for a release.
- `workflow_start` runs a published version against a real VibeX workspace ID.
- `workflow_debug_from_step` debugs an already-published version.

## Pause, continue, review

- `workflow_pause_run` stops the DAG without failure.
- `workflow_pause_step` then `workflow_continue_step` intervene in one node Conversation. Any intervened Turn needs `workflow_accept_candidate` before downstream execution.
- A manual Agent Step's confirmation node is a Studio projection, not a definition step or dependency.
- `workflow_review_step` retries, accepts, or skips a step that is explicitly `needs_review`.
- `workflow_cancel_run` is permanent termination. Pause is the default reversible stop.

## Do not

- Do not edit database records or invent version IDs.
- Do not copy credentials into source files.
- Do not treat Studio as a second source of truth.
- Do not publish in order to "just test".
