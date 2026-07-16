# Spec: Prepared ACP Session Controls

**Author:** Codex
**Date:** 2026-07-16
**Status:** Implemented
**Supersedes:** `agent-capability-catalog.md` for session controls

## Decision

The concrete ACP Session is the only authority for a Conversation's modes and
configuration options. VibeX creates that Session as soon as the create form
has an Agent and an existing Workspace, renders the `session/new` response,
and persists the Conversation with the same UUID. It does not copy the values
to another Session and does not reconstruct them from profiles, probes,
catalogs, or browser storage.

## Lifecycle

1. The form allocates the future Conversation UUID.
2. `agent_prepare_session` resolves the verified local CLI/ACP paths and opens
   the real ACP Session for the selected Workspace.
3. The form renders the returned modes and `configOptions` verbatim.
4. A selection calls `session/set_mode` or `session/set_config_option` on that
   same Session. The full response replaces the displayed controls so dynamic
   dependencies (for example OpenCode model -> effort) remain authoritative.
5. Creating the Conversation persists the prepared UUID and commits ownership
   of the Session. Cancelling the form closes/discards the draft Session when
   supported.
6. When the Conversation service adopts the Session, the current controls are
   re-emitted into its event log for recovery and rendering.

## Protocol rules

- When non-empty `configOptions` are advertised, VibeX ignores legacy modes as
  required by ACP instead of merging two representations.
- Select values retain their raw IDs. Boolean options remain JSON booleans on
  the wire and render as switches.
- VibeX advertises stable boolean config-option support in the ACP client
  initialization capabilities.
- The local CLI and ACP adapter selected by Settings are mandatory; launch
  never silently falls back to a runtime bundled inside an adapter package.

## Acceptance criteria

- Opening selectors never reads the capability catalog or browser storage.
- The Session shown in the form and the Session used by the Conversation have
  the same UUID and external ACP Session ID.
- Model, effort, permission, mode, and Fast options are exactly those returned
  by the installed Agent/adapter pair.
- Model-dependent choices update after each ACP set-config response.
- A failed preparation cannot be submitted and does not leave an owned draft
  Session behind.
- Installing/updating an Agent invalidates runtime availability only; it does
  not start a second session-control discovery process.

## Scope boundary

The historical capability catalog may temporarily remain for non-session
OpenCode settings such as provider/default-model assistance. It is isolated
from both the create-session form and Conversation composer and therefore is
not a competing Session-control truth source.
