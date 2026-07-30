# Design: Open ACP Registry Agent Management

## Cutover shape

Build the new management subsystem behind internal constructors and test seams,
then make one product cutover: all settings, install/probe/session eligibility
and conversation Agent lookup read the new management model. Delete the old
closed setting/registry path in that same cutover. Temporary construction code
may coexist on a branch, but there is no released UI with two management
systems, no legacy command alias, and no fallback to the old seven entries.

```text
Official ACP Registry ──> RegistrySnapshotStore ─┐
Built-in Profiles (app-bundled) ──────────────────┤
                                                   v
                                        AgentCatalog / AgentId binding
                                                   v
Agent membership ─> ProbeService ─> Management snapshot ─> Tauri DTO/events
                         |                    |                     |
                         v                    v                     v
                InstallationOrchestrator  ConfigProvider       Settings Agent UI
                         |                    |
                         v                    v
                  Installation lock ─> crates/agents runtime ─> ACP stdio
```

The Registry is never read directly by the session runtime. The runtime receives
an absolute local launch plan produced from a verified current Installation lock.

## Domain model

### Open identity

Replace `AgentKind` as the product identity with `AgentId(String)`:

- canonical, lower-case, non-empty stable identifier;
- persisted in new tables and conversation bindings;
- the Registry id is recorded separately and can be rebound only by an explicit
  Built-in Profile mapping or migration;
- legacy spellings are parsed only by an isolated migration adapter, which emits
  an `AgentId` or a `RetiredAgentId`; it is not available to live APIs.

`QaMock` remains a test fixture identity, not a product catalog member. No new
management type or frontend component accepts a Rust enum of product Agents.

### Aggregate records

Use normalized records rather than extending `agent_setting`:

| Record                             | Key facts                                                                                     | Owner                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------- |
| `agent_membership`                 | AgentId, source/built-in/retired flags, enabled, bar position, locally retained metadata/icon | user selection         |
| `registry_snapshot`                | official source, fetched time, schema version, raw validated document/hash                    | Registry cache         |
| `agent_registry_entry`             | snapshot id, Registry id/version/metadata/distributions/icons                                 | Registry projection    |
| `agent_installation`               | ownership, lifecycle status, current and rollback lock references, operation state            | installer              |
| `agent_install_component`          | Runtime/ACP/base Runtime exact path/version/hash/trust                                        | installation lock      |
| `agent_probe` / `agent_diagnostic` | latest state plus bounded operation history/redacted output                                   | probe/orchestrator     |
| `agent_config_binding`             | Profile-known native config candidate, revision/fingerprint, recognized fields                | configuration provider |
| `agent_session_default`            | global new-session ACP option ids/values only                                                 | VibeX preference       |

All update/delete operations are transactional at membership/lock boundaries.
Diagnostics are bounded to 20 entries per Agent in the repository transaction;
raw secrets are redacted before persistence.

### Status calculation

`AgentManagementSnapshot` is a projection, not a mutable boolean bag. It
combines membership, installation, last probe, active operation, authentication
status and platform compatibility in a precedence table:

1. retired or platform unsupported;
2. active operation (queued/installing/updating/repairing);
3. missing/invalid required component or hash mismatch (needs repair);
4. installed but required authentication/config absent (needs auth/config);
5. installed and ready;
6. uninstalled.

Enabled is orthogonal and overlays the snapshot. A disabled ready Agent remains
ready but fails the session-eligibility gate with an explicit disabled reason.

## Profiles, Registry, and installation

### Built-in Profiles

Profiles are compile-time/bundled declarative data for Claude Code, Codex,
OpenCode and Pi. A profile contains:

- fixed AgentId, display metadata and verified brand icon;
- optional explicit Registry binding;
- topology (`native_acp` or `adapter_backed`), supported platform matrix,
  distribution choice, expected SHA-256 and required component versions;
- official absolute-path candidates for read-only external detection;
- recognized native configuration-file candidates/fields and authentication
  status precedence; and
- optional local status/usage reader, never an interactive login runner.

No Profile contains custom UI JSX, a dedicated state machine, a generic shell
command, or remotely updateable Runtime contract data.

### Registry client

`RegistryClient` fetches only the ACP official HTTPS Registry endpoint. It
deserializes and validates the stable schema, sanitizes/cache-validates SVG
icons, writes a complete snapshot atomically, and exposes the previous snapshot
on failure. It performs no install or session action. Generic add/update calls
require a successful current refresh; built-in install/repair does not.

### Planner and orchestrator

`InstallPlanner` is pure and returns either a typed plan or an explicit reason:

```text
profile: profile-declared distribution
generic: compatible binary > verified Node + npx > verified Python + uvx
```

It locks Registry version, platform and resolved package/artifact data. The
orchestrator owns staging, hash/ecosystem verification, ACP initialize,
diagnostic redaction, atomic current-lock switch, cancellation cleanup and one
rollback lock. It schedules at most two mutating jobs, locks shared resources,
and serializes per Agent operations. A job never changes membership on failure.

External built-in detection only adopts a candidate after absolute path, version,
required hash and ACP handshake pass. Managed operations never mutate external
components. `uninstall`/`remove` check active ACP connections, active turns and
operations first and return the required blocking reason without cancellation.

## Configuration and authentication

`NativeConfigProvider` is a Profile-declared, version-aware file adapter. It
reads the latest known file, parses only the supported JSON/TOML/etc. shape,
patches explicit fields, atomically writes, rereads, detects concurrent edits,
and never becomes a full raw-file editor. It creates a missing official default
file only on explicit user save. Profiles may expose understood Runtime fields
such as endpoint, credentials, model, reasoning, and native behavior options
across multiple official JSON/TOML files. It supplies API Key status by presence
and masks value on presentation; account login status is probe-only. The read
projection also carries the exact on-disk source for each declared file so the
form can show a read-only preview without fabricating or dropping unknown
fields. Credential-bearing previews are masked except during hover/focus.
All field edits and removals remain draft changes until the shared settings
action bar saves them. Session defaults remain ACP session options and are
applied only to new/rebound sessions when still advertised.

## Tauri and runtime APIs

Keep existing ACP session commands (`agent_connect`, `agent_new_session`,
`agent_send_prompt`, etc.) but change their Agent reference to `AgentId` and
gate every start/turn against `AgentManagementService::session_eligibility`.

Introduce typed management commands with snapshots, never raw DB rows:

```text
agent_management_bar
agent_management_detail
agent_registry_view
agent_registry_refresh
agent_registry_add_and_install
agent_management_set_enabled
agent_management_reorder
agent_management_preflight
agent_management_repair
agent_management_update
agent_management_uninstall
agent_management_remove
agent_management_config_read
agent_management_config_write
agent_management_clear_diagnostics
```

Long operations emit typed management events (`operation_started`, `progress`,
`completed`, `failed`, `snapshot_changed`) keyed by AgentId. Commands return
structured domain errors so the UI can render the blocking process message and
Toast feedback without parsing strings.

## Frontend design and state

Create `features/agent-management` as the sole source for query keys, IPC calls,
event reduction, Registry cache state and optimistic UI transitions. Replace the
static `constants/agents.ts`, `useSelectableAgents` joins and the hard-coded
`AgentConfigManager` specification map. The current `AgentSettings` becomes a
thin composition of:

```text
AgentBar
  ├─ selected Agent -> AgentDetail
  │    ├─ SummaryAndActivation
  │    ├─ PreflightSection
  │    ├─ RuntimeInstallationSection
  │    ├─ AuthenticationAccountSection
  │    ├─ NativeConfigurationSection
  │    └─ DiagnosticsSection
  └─ + -> AgentRegistryView
       ├─ InstalledTab
       └─ UninstalledTab
```

The bar is the glass control layer; Registry and detail sections are opaque
grouped content surfaces. Use VibeX tokens, standard controls, focus-visible
states, reduced-motion fallbacks, semantic status text plus icons, accessible
names, and no modal-first Registry or arbitrary card grid. Rows and Agent icons
must render from cached profile/Registry data without network work in render.
The detail summary header groups ordering and activation controls with manual
update and uninstall actions; preflight contains only checking, repair,
diagnostic export, progress, and its state cards.

## Migration and deletion

The migration runs once, transactionally and offline:

1. create new records and built-in memberships;
2. parse old canonical/lenient Agent names only through a migration map;
3. classify actual-use evidence before creating generic Gemini/Cline membership;
4. retain old enabled state only after membership is decided; migrate relative
   order and append Pi;
5. create retired history bindings for OpenClaw/Hermes without membership;
6. migrate conversation Agent references to AgentId and record legacy/runtime
   provenance where available; and
7. atomically mark the migration complete, then delete old seed/lookup code in
   the same release once data verification passes.

Deletion targets include the closed `AgentKind` live API, seven-row default
seeding, static frontend Agent constants/selector mapping, hard-coded registry
entries, per-Agent configuration UI maps, old global installer actions, and all
tests asserting those contracts. Retired-name parsing is allowed only in the
migration/history reader.

## Risks and mitigations

| Risk                                                  | Mitigation                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Open identity ripples through conversations/executors | Convert public types first, use compiler errors as deletion map, then remove enum bridges before UI cutover. |
| Official Registry has no Binary checksum              | Manifest TOFU is visible, lock-bound and quarantines changes; built-ins require expected SHA-256.            |
| Native formats/version differences                    | Profile adapters declare versions/paths; unsupported format is omitted, never raw edited.                    |
| External config changes during editing                | Re-read + field conflict resolution before atomic write.                                                     |
| Long install work races UI updates                    | Server snapshots/events are authoritative; frontend only performs bounded optimistic membership creation.    |
| Dirty repository and existing partial ACP work        | Isolate work to the new phase and replacement modules; never overwrite unrelated modifications.              |
