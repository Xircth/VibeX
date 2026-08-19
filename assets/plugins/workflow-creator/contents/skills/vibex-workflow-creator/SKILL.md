---
name: vibex-workflow-creator
description: Design, edit, validate, publish, inspect, and debug VibeX *.vibex-workflow.json DAGs with the dedicated vibex-workflow-mcp.
---

# VibeX Workflow Creator

Use this Skill when the user asks to create or change a VibeX Workflow.

1. Find or create exactly one `*.vibex-workflow.json` source artifact, either project-relative or below `~/.vibex/workflows/`. Read an existing artifact with `workflow_source_read` before editing and retain its revision.
2. Model nodes as durable steps, not as Agents. An Agent Step owns one child Conversation; retries and user continuation add Turns to that same Conversation.
3. Give every step a stable kebab-case ID. Encode ordering only through `dependsOn`. Never create a cycle or reference a missing step.
4. Use `inputBindings` and JSON Pointers for data flow. `outputSchema` is an Agent-facing output example embedded into the initial prompt; it never validates or blocks the final Assistant text. Downstream steps receive that final text even when it is not valid JSON.
5. Select `executorProfileId`, `modeOverride`, and `configOverrides` from the Agent's native session controls. Do not invent or expose Workflow-specific permission modes. Omit scheduling metadata unless the user explicitly asks for a particular workspace-isolation strategy; the Host supplies backward-compatible defaults. Use `completionPolicy: manual` only when the user wants a confirmation projection after the Agent Step.
6. Save with `workflow_source_write` and the revision from the read. On conflict, read again and reconcile; never overwrite blindly.
7. Save and validate before testing. Call `workflow_debug_source` to test the current source through a hidden durable snapshot; it must not publish a version or retarget an Automation. For later attempts, pass `parentRunId` and use `node` to isolate one node or `downstream` to retain unchanged completed ancestors and rerun the selected transitive branch.
8. Publish only when the user explicitly asks for a release: call `workflow_publish` to create an immutable visible version. Use `workflow_start` only for a published version and a real VibeX workspace ID. Keep `workflow_debug_from_step` for debugging an already-published version.
9. Use `workflow_pause_run` to stop the DAG without failure. Use `workflow_pause_step`, then `workflow_continue_step`, to intervene in one node Conversation. Any intervened Turn requires `workflow_accept_candidate` before downstream execution. A manual Agent Step's confirmation node is a Studio projection, not a definition step or dependency.
10. Use `workflow_review_step` to retry, accept, or skip an interrupted Step that is explicitly in `needs_review`. Use `workflow_cancel_run` only for permanent termination. Pausing is the default reversible stop.

Do not edit database records, invent version IDs, copy credentials into source files, or treat an in-memory graph as authoritative.
