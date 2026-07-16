# Spec: Agent Capability Catalog

**Author:** Codex
**Date:** 2026-07-15
**Status:** Superseded
**Reviewers:** Project maintainer
**Related decisions:** ADR-0002 (single agent-identity enum)

> Superseded on 2026-07-16 by
> [`prepared-acp-session-controls.md`](./prepared-acp-session-controls.md).
> A persisted catalog is no longer a source for create-session or composer
> controls. Those controls now come from the concrete ACP Session that the
> Conversation adopts.

## Context

VibeX currently obtains session configuration choices through four competing
paths: a prior Conversation event, an on-demand ACP discovery probe, static
executor profiles, and a browser-local cache. Opening the create-session form
can therefore spawn an ACP process and wait for `session/new`; the reported
latency is 3--5 seconds. The choices can also be stale or incomplete because
the static profile list is not account- or agent-version-aware.

The problem is visible for Codex models, permissions, reasoning effort, and
Fast mode, and is not specific to Codex. Model identifiers and labels are
agent-owned values: changing their casing or substituting a project-maintained
list can make a choice invalid for the current account. A session control is
only useful if VibeX can apply the exact advertised value to the agent.

The product needs immediate, complete configuration controls in both the
create-session form and an existing Conversation composer, without presenting
invented choices. ACP has no pre-session discovery request, so freshness must
be obtained before a user opens either surface and stored locally.

## Functional Requirements

- FR-1: VibeX MUST persist one `CapabilityCatalog` snapshot for the active
  configuration of each Agent kind. That snapshot is the only source from
  which create-session and composer configuration selectors read choices.
- FR-2: A catalog snapshot MUST contain the agent-provided raw option ID,
  raw choice value, agent-provided label/description, category, current value,
  retrieval time, and a configuration fingerprint.
- FR-3: VibeX MUST refresh a catalog in the background after app startup,
  successful agent installation, relevant agent authentication/configuration
  changes, and an explicit user refresh. It MUST NOT run an ACP subprocess in
  response to a selector or create-session-form read.
- FR-4: A successful ACP `session/new` advertisement or subsequent ACP
  session-control update MUST atomically replace the matching catalog snapshot.
  A failed refresh MUST retain the most recent valid snapshot unchanged.
- FR-5: A catalog whose fingerprint does not match the active agent
  configuration MUST be treated as unavailable for choice selection; VibeX
  MUST NOT reuse it merely because it is non-empty.
- FR-6: If no matching catalog is available, both UI surfaces MUST render
  the currently selected executor/default value as non-selectable context and
  a synchronization status; they MUST NOT synthesize model, permission, mode,
  effort, or Fast choices from executor profiles, conversation events, or
  browser storage.
- FR-7: VibeX MUST preserve raw agent model IDs and raw choice values for
  writes. It MAY format a display label only when the agent supplied no label;
  formatting MUST NOT alter the raw value sent to the agent.
- FR-8: A selector choice MUST be applied using its cataloged transport and
  raw option/choice IDs. A choice which cannot be applied by that transport
  MUST NOT be selectable.
- FR-9: Fast MUST be represented as a capability, not a hard-coded Codex
  boolean. When the active Codex catalog advertises a writable Fast/service-tier
  control, VibeX MUST expose it in the same session-control UI and apply its
  advertised value. When it does not advertise such a control, VibeX MUST NOT
  render a session-level Fast switch; the existing global Codex configuration
  remains the only Fast-default control and MUST be labelled as global.
- FR-10: The existing event-log lookup, static-profile synthesis, and
  `localStorage` session-controls cache MUST be removed from the selector read
  path. Executor profiles MAY continue to define execution defaults, but MUST
  NOT define selectable capability catalogs.
- FR-11: Catalog mutations and reads MUST remain scoped by the canonical
  `AgentKind` identity defined by ADR-0002.

## Non-Functional Requirements

- **NFR-P1:** Opening either selector surface with a matching catalog MUST
  perform no process spawn, network request, or ACP RPC, verified by an
  integration test with a spawn-counting probe.
- **NFR-P2:** The backend catalog read MUST complete in under 100 ms for 100
  consecutive local reads on the test machine; the median and maximum duration
  MUST be recorded by the benchmark/test harness.
- **NFR-R1:** A failed, timed-out, or malformed refresh MUST NOT delete or
  partially overwrite the last valid matching snapshot.
- **NFR-R2:** Snapshot replacement MUST be transactional: readers observe
  either the whole preceding snapshot or the whole succeeding snapshot.
- **NFR-A1:** Every enabled selector and synchronization indicator MUST expose
  an accessible name and disabled state through the existing component library.
- **NFR-S1:** Catalog persistence MUST NOT store credentials, access tokens,
  full launch environment values, or prompts. The fingerprint MUST be a
  non-reversible digest of the relevant public configuration/version inputs.

## Acceptance Criteria

### AC-1: Immediate catalog-backed create form (FR-1, FR-3, NFR-P1)

Given a matching CapabilityCatalog snapshot for Codex
When the user selects Codex in the create-session form
Then the form renders the cataloged controls without invoking the ACP probe
And the recorded probe spawn count is zero.

### AC-2: Immediate catalog-backed composer (FR-1, NFR-P1)

Given a matching CapabilityCatalog snapshot for an agent
When the user opens that Conversation composer
Then its configuration selectors use the same catalog choices
And no agent process or ACP request is initiated by opening a selector.

### AC-3: Exact model values and labels (FR-2, FR-7)

Given a catalog with `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`
When either UI renders the model selector
Then it displays the agent-provided labels
And selecting `gpt-5.6-sol` writes exactly `gpt-5.6-sol` through the cataloged
transport.

### AC-4: Atomically refreshed capability set (FR-3, FR-4, NFR-R1, NFR-R2)

Given a valid catalog snapshot
When a background refresh returns a different complete capability set
Then subsequent reads return the new set as one snapshot
And a refresh error leaves the prior snapshot available and unchanged.

### AC-5: Stale catalog is not a fallback (FR-5, FR-6, FR-10)

Given a saved catalog whose fingerprint differs from the active agent
When the user opens either selector surface
Then no capability choices are offered
And the UI indicates synchronization is required
And no profile, event-log, or browser-storage choices are displayed.

### AC-6: Fast capability is truthful (FR-8, FR-9)

Given a Codex catalog advertising a writable Fast/service-tier choice
When the user selects its enabled Fast value
Then VibeX writes that exact advertised option/value pair.

Given a Codex catalog without a writable Fast/service-tier choice
When the user opens either session-control surface
Then no session-level Fast switch is rendered.

### AC-7: No secret persistence (NFR-S1)

Given a catalog refresh initiated with agent launch settings
When the snapshot is persisted
Then its serialized payload contains no launch environment value, credential,
access token, or prompt.

### AC-8: Read-path budget (NFR-P2)

Given a matching persisted snapshot
When the catalog read is executed 100 times by the benchmark harness
Then every read completes in less than 100 ms
And the harness records median and maximum duration.

### AC-9: Canonical agent identity (FR-11)

Given the same agent is addressed by a historical spelling and its canonical
`AgentKind`
When catalog data is read or refreshed
Then both operations resolve to the one canonical AgentKind catalog record.

## Edge Cases and Error Scenarios

- EC-1: Agent is not installed or unauthenticated during refresh -> record a
  refresh failure state; do not create an empty valid snapshot.
- EC-2: ACP returns no session controls -> preserve any prior valid
  snapshot only if its fingerprint still matches; otherwise expose no choices.
- EC-3: ACP responds after the refresh timeout -> discard the response and
  leave the stored snapshot unchanged.
- EC-4: Two refresh requests for the same Agent kind and fingerprint run
  concurrently -> coalesce them or serialize writes; readers never see a
  partially merged result.
- EC-5: Agent CLI version, account, provider/model configuration, or
  capability-affecting native setting changes -> fingerprint mismatch blocks
  old choices until a fresh catalog is stored.
- EC-6: An active live Conversation receives a control update -> update the
  catalog and the live controls; a later stale refresh MUST NOT overwrite a
  newer update for the same fingerprint.
- EC-7: A catalog option has no label or description -> show a deterministic
  display-only fallback derived from its raw ID; retain the raw ID for writes.
- EC-8: Fast is configured globally but absent from the session catalog ->
  do not imply that toggling it would affect only one Conversation.

## API Contracts

```ts
type CapabilityCatalogStatus =
  | 'ready'
  | 'refreshing'
  | 'unavailable'
  | 'stale';

type CapabilityChoice = {
  value: string;
  label: string | null;
  description: string | null;
};

type CapabilityOption = {
  id: string;
  label: string | null;
  description: string | null;
  category: string | null;
  currentValue: string | null;
  choices: CapabilityChoice[];
  writable: boolean;
};

type AgentCapabilityCatalog = {
  agentType: AgentType;
  fingerprint: string;
  status: CapabilityCatalogStatus;
  retrievedAt: string | null;
  options: CapabilityOption[];
  modes: AgentSessionMode[];
};

type GetAgentCapabilityCatalog = (
  agentType: AgentType
) => Promise<AgentCapabilityCatalog>;

type RefreshAgentCapabilityCatalog = (
  agentType: AgentType
) => Promise<{ accepted: true }>;

interface CapabilityCatalogCommands {
  agent_capability_catalog(agentType: AgentType): Promise<AgentCapabilityCatalog>;
  refresh_agent_capability_catalog(
    agentType: AgentType
  ): Promise<{ accepted: true }>;
}
```

`GetAgentCapabilityCatalog` is read-only and MUST NOT trigger discovery.
`RefreshAgentCapabilityCatalog` schedules/coalesces background discovery and
returns before a slow agent completes. Existing session-control write commands
remain source-compatible; their implementations resolve the selected raw
catalog option before sending ACP.

## Data Models

| Entity | Field | Type | Constraints |
| --- | --- | --- | --- |
| CapabilityCatalog | agent_type | canonical AgentKind | primary key component; ADR-0002 identity |
| CapabilityCatalog | fingerprint | SHA-256 hex string | primary key component; no secret plaintext |
| CapabilityCatalog | status | ready/refreshing/unavailable/stale | required |
| CapabilityCatalog | retrieved_at | UTC timestamp nullable | non-null only after successful refresh |
| CapabilityCatalog | generation | unsigned integer | monotonically increases per agent/fingerprint |
| CapabilityCatalog | controls_json | JSON | complete validated snapshot; no secrets |
| CapabilityCatalog | refresh_error_code | nullable stable string | no raw credential/error payload |

The active catalog is the newest `ready` row matching the current fingerprint.
Old rows MAY be pruned after a successful replacement; pruning is not on the
selector read path.

## Out of Scope

- OS-1: Maintaining a VibeX-owned global model list. Account eligibility
  and agent capability advertisements are external and must not be guessed.
- OS-2: Changing Codex account entitlements, agent model availability, or
  ACP protocol behavior upstream.
- OS-3: Treating a global Codex `config.toml` Fast default as a per-session
  setting when the active capability catalog does not advertise a writable
  session control.
- OS-4: Rewriting unrelated executor profile management, provider settings,
  or Conversation event-sourcing semantics.
- OS-5: Historical migration of browser-local cache data into the catalog;
  it is untrusted selector data and will be ignored.
