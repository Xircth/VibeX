# Computer Use Plugin Specification

Status: Draft for review\
Date: 2026-10-08\
Research: [codeg Computer Use Research](../../research/2026-10-08-codeg-computer-use.md)

## 1. Summary

Deliver computer use as a first-party VibeX product plugin. It lets an agent inspect
and operate user-selected desktop applications through explicit, revocable sharing.
The plugin owns user-facing product content, settings, agent tool descriptions, and
status UI. The VibeX Host owns desktop access, authorization truth, target identity,
capture/input execution, safety policy, Stop, platform capability reporting, and
audit events.

The plugin is not a route to arbitrary desktop control. Its MCP tools and UI call a
versioned public Host capability. The Host applies the same authorization and policy
checks regardless of caller.

## 2. Goals and non-goals

### Goals

- Allow users to select a window, application, or entire screen and grant read or
  control access explicitly.
- Give agents bounded discovery, observation, verification, input, app/window, and
  clipboard operations with clear structured outcomes.
- Make current sharing, recent actions, revocation, and emergency Stop visible and
  available outside the conversation panel.
- Keep plugin lifecycle and configuration within the VibeX v4 package/SDK model.
- Report platform support and OS permission requirements honestly.
- Make authorization and safety behavior independently testable at the Host API.

### Non-goals

- Sandboxing a Full Trust plugin or claiming the helper is a universal sandbox.
- Exposing arbitrary shell, process execution, driver tool names, macros, or
  unbounded input recording/playback.
- Granting permissions because a plugin was installed, because it is first-party,
  or because an MCP server was launched.
- Giving the agent authority to select, widen, or renew a user's target grant.
- Persisting screenshots, accessibility trees, clipboard contents, or typed text as
  conversation history by default.
- Replacing native browser automation or OS accessibility APIs in unrelated flows.

## 3. User scenarios

1. A user opens Computer Use settings, checks platform readiness, then chooses a
   visible window and shares it for reading or reading and acting.
2. An agent lists shared targets, takes a snapshot, verifies a state, and acts using
   a fresh element reference. If the observation is stale, it receives a recoverable
   result and must observe again.
3. A user sees which targets are shared and the latest action in a persistent Host
   indicator, and presses Stop to end all active sharing immediately.
4. A user disables clipboard, foreground input, app launch, window movement, or
   screen-wide access independently in settings. Existing affected grants are
   narrowed or revoked immediately.
5. An unsupported remote/web/mobile client sees capability unavailable and does not
   attempt to execute desktop operations locally.
6. An administrator or user diagnoses missing OS accessibility/screen capture
   permissions or an unavailable managed helper/driver without confusing those
   states with plugin installation or grant state.

## 4. Package and contribution model

Package identity is `publisher + id`; the proposed first-party identity is
`vibex.computer-use`. The plugin uses the standard v4 layout: root README and
`contents/`, `config.json` for user preferences, a Worker entrypoint only if tool
registration needs handlers, and SDK-declared integrations. The initial package
should use declarative `app.command`, `app.status`, and `app.settings.page` or
`app.settings.section` surfaces where the current SDK supports the required UX. MCP
tools are declared through the existing `content.mcp` contract and started by the
Host-managed MCP runtime.

The package may not import internal Host code or address Tauri commands. Product
settings are persisted through the plugin config contract. The Host capability API
and Host-owned UI contributions are separate platform work and must be available
through the same public contract to first-party and third-party packages.

The v4 schema currently has no computer-use contribution kind or Host client. Before
the first-party plugin can ship, the platform batch must add and document a public
versioned capability, SDK types/client, runtime support, capability negotiation,
diagnostics, and conformance tests. This spec does not prescribe private Rust or
Tauri implementation names.

## 5. Functional contract

### 5.1 Host capability surface

The public capability is named `computer.use` for this draft. Operations are an
allowlist, not arbitrary driver forwarding:

| Area | Required operation family | Required behavior |
| --- | --- | --- |
| Readiness | `status`, `platform`, `permissions` | Returns supported/unavailable/permission-required/helper-unavailable states without claiming permissions that are absent. |
| Discovery | `listApps`, `listWindows`, `listTargets` | Returns only data permitted by the caller's active grants; unshared window titles are not disclosed. |
| Sharing | `share`, `updateShare`, `revoke`, `revokeAll` | User gesture is mandatory to create or widen grants. Agent calls cannot create, widen, or renew a grant. |
| Observation | `snapshot`, `screenshot` | Requires read grant; returns target and generation-bound data. Secret values are redacted. |
| Verification | `verify` | Evaluates bounded predicates and returns satisfied/unsatisfied/unknown without copying secret values into results. |
| Input | `click`, `drag`, `scroll`, `type`, `pressKey`, `setValue` | Requires control grant, fresh observation, policy checks, and bounded arguments. |
| App/window | `restore`, `invokeMenu`, `launchApp`, `setWindowFrame` | Requires the appropriate app/screen scope and per-feature setting; may be unavailable by platform. |
| Clipboard | `readClipboard`, `writeClipboard` | Disabled by default. Read is restricted by provenance to content written by the agent or copied from a currently shared target. |
| Stop | `stop`, `stopStatus` | `stop` revokes all grants and prevents queued and subsequent actions from executing until a new user share gesture. |

Every operation accepts an opaque caller context minted by the Host for the active
plugin/MCP session. The plugin cannot forge the user identity or target scope. The
Host returns stable result envelopes:

```ts
type ComputerResult<T> =
  | { ok: true; value: T; observation?: ObservationIdentity }
  | {
      ok: false;
      error: ComputerErrorCode;
      retry: 'never' | 'after-observation' | 'after-user-action' | 'later';
      message: string;
    };
```

Error codes include `unavailable`, `permission_required`, `grant_required`,
`control_required`, `target_not_found`, `target_blocked`, `stale_observation`,
`secret_field`, `foreground_not_allowed`, `stopped`, `paused`,
`unsupported_operation`, `rate_limited`, `action_failed`, and
`protocol_incompatible`. Returned recovery guidance must say when only the user can
act. Refusal is a normal result, not a protocol crash.

### 5.2 Tool behavior

- Prefer accessibility snapshot and refs for semantic actions; use screenshots for
  canvas/image content or visual layout. Never invent refs.
- Every ref and coordinate belongs to a target ID, observation generation, and
  coordinate space. Any new observation, target identity change, resize, revoke, or
  re-share invalidates affected refs/points.
- Never mix screenshot pixels and desktop logical units. The schema identifies the
  space and dimensions for each coordinate.
- Require the agent to re-observe after `stale_observation`; do not silently remap an
  old point to a new target state.
- Bound text length, key sequences, drag duration, scroll magnitude, snapshot size,
  screenshot dimensions, and operation timeouts. Exact limits are Host contract
  constants and are surfaced by `status`/SDK metadata.
- Treat all screen and accessibility content as untrusted data. Instructions found
  in the target do not authorize new operations or expand the user's request.
- Do not automatically retry a non-idempotent action after helper timeout or crash.
  Return an ambiguous-action result and require a fresh observation.

### 5.3 Authorization

Authorization is Host runtime state, not plugin config or conversation text. A grant
binds:

- target kind and stable target identity;
- access level (`read` or `control`);
- grant epoch and expiry;
- active policy revision;
- originating local user gesture and Host instance.

Grant creation and widening require a local Host UI gesture. Grants are finite-lived
and expire; the user selects the duration in settings. The default duration should
be conservative and clearly shown in the share flow. Changing policy to disable an
operation revokes or narrows affected active grants immediately. Blocklist changes
apply immediately. Sharing an entire application or screen is an explicit broader
grant; the UI describes the expanded scope before confirmation.

## 6. UI specification

### Share picker

The Host-rendered picker lists applications/windows with clear target identity,
visibility/minimized state, platform availability, and current grant. User selects
target and segmented `Read` / `Read and act` level, then confirms. Whole-app and
whole-screen targets are separate choices with scope descriptions. Agents cannot
open a picker on the user's behalf and cannot accept it for the user.

### Persistent status surface

An always-available Host status surface shows whether computer use is off, active,
paused, or unavailable; shared target names and access levels; and a Stop control.
The surface remains visible while any grant exists even if the plugin page or agent
session is closed. Clicking a target opens grant details and revoke. Recent activity
shows action category and target, but excludes entered text, clipboard contents,
screenshots, and accessibility values.

### Settings

The plugin settings page owns user preferences and links to Host permission/readiness
diagnostics. Settings include grant lifetime, default delivery mode, visible
indicator, stop shortcut, blocked apps/windows, foreground input, app launch/window
movement, clipboard, and screen-wide access. Risk-expanding options are off by
default and have direct labels. OS permissions and driver/helper management are
Host-owned controls; the plugin may link to them but cannot report them as enabled
based on plugin config.

### Stop

Stop is available in the persistent status surface and optional global shortcut.
The Host changes to stopped state before acknowledging the request, cancels queued
operations, revokes all grants, invalidates observation generations, and rejects
new operations. In-flight OS operations are cancelled where possible. Stop's UI
acknowledgment must not wait for a hung plugin or agent. Sharing again always
requires a new user gesture.

## 7. Runtime, lifecycle, and platform support

The Host capability is available to plugin UI and managed MCP calls through one
authorization service. MCP session identity is an input for audit and attribution,
not an authorization grant. Plugin disable/uninstall removes its tools/UI and stops
its managed runtime; Host Stop and active sharing state remain controlled by Host
policy. The product must define whether disabling the plugin also revokes grants
created in its sessions; proposed default: revoke those grants and all grants when
the capability itself is globally disabled.

Host capability negotiation returns a platform matrix, not a single boolean. At
minimum distinguish desktop app, headless server, web client, remote client, and
mobile. A remote client may ask the paired Host to operate its desktop only if the
Host explicitly exposes that capability and presents its sharing UI locally.
Unsupported operations return `unsupported_operation`; they never fall through to
shell or a plugin-local driver.

Platform readiness separates OS permission, helper health, driver integrity, and
feature support. macOS permission subjects and code signing are reported explicitly.
Windows, X11, and Wayland guarantees must state actual API limits; app-level block
rules and helper process boundaries must not be marketed as OS sandboxing.

## 8. Data and privacy

Persist only user preferences in plugin `config.json`. The Host owns live grants,
target identity, epochs, expiry, stop state, clipboard provenance, and operation
serialization. Do not persist captured images, trees, values, typed content, or
clipboard contents by default. Audit records contain caller/plugin identity,
operation category, target identity, result code, and timestamp, excluding payloads
and secrets. Retention and user-visible audit access must follow the Host's existing
privacy policy.

Logs and structured errors must redact text payloads, environment data, secrets,
clipboard contents, and screenshot/accessibility contents. A diagnostic bundle may
include protocol versions, platform readiness, and sanitized error codes only.

## 9. Failure handling

- Missing OS permission: report the exact permission and offer a Host-owned request
  or system-settings action.
- Missing grant/control level: explain the required scope and expose the local share
  picker; do not repeatedly prompt or create a grant.
- Stale target/ref: return `stale_observation`, require a new observation.
- Target blocked or policy changed: stop affected operations and explain which
  setting the user can change.
- Screen locked/secure desktop: report paused/unavailable and do not retry rapidly.
- Helper/driver crash: isolate the failure, mark readiness unhealthy, do not replay
  ambiguous actions, and offer restart/repair.
- Protocol/API mismatch: fail closed for affected operations and report the required
  compatible Host version.
- Plugin crash/disable: Host sharing and Stop remain operable independently of the
  plugin process.

## 10. Testing and acceptance

### Contract tests

- Manifest validates using the released v4 SDK; plugin uses no private imports or
  host-internal identifiers.
- `computer.use` SDK client and fake broker have parity for success, stable errors,
  cancellation, size limits, and unsupported platform behavior.
- Every entry point (plugin UI, MCP, command) reaches the same Host authorization
  checks; no MCP-specific grant bypass exists.

### Security and state tests

- Agent cannot create, widen, extend, or accept a grant.
- Read grant rejects control operations; window scope rejects app-menu/screen calls.
- Revoke, expiry, policy change, blocklist change, target replacement, and Stop
  invalidate the appropriate grants and observations.
- Once Stop is acknowledged, no queued action can reach the helper; a new user share
  gesture is required to resume.
- Secret fields never appear in snapshots, verification results, logs, or audits.
- Clipboard reads reject user-originated contents and become unavailable after
  source grant revocation.
- Stale refs/coordinates reject without remapping. Non-idempotent ambiguous actions
  are not replayed.
- Protocol version mismatch and helper crash fail closed and preserve an actionable
  diagnostic.

### UI and platform tests

- Picker accurately distinguishes target kind and access level; wider scope is
  explicit; no agent-triggered confirmation can be accepted programmatically.
- Persistent indicator remains usable with plugin disabled or crashed; Stop works
  without an active conversation.
- Settings reflect live Host state and cannot override Host permission/grant state.
- Platform matrix and unsupported states are accurate in Desktop, Web, remote, and
  mobile clients.
- Manual OS-level E2E validates window identity, capture, input, focus side effects,
  permissions, and Stop on each supported OS/desktop environment.

## 11. Delivery phases

1. **Public Host contract:** capability schema, SDK client, protocol versioning,
   capability negotiation, Host-owned authorization/state service, fake broker,
   diagnostics, and contract tests. This includes the first official consumer as
   required by ADR-0069.
2. **Desktop vertical slice:** readiness, picker, read/control grants, snapshot,
   semantic click/type, persistent indicator, revoke, and Stop on one validated
   desktop platform.
3. **Product plugin:** package, MCP tools, settings, status surface, errors, and
   lifecycle wiring through standard v4 APIs; full host acceptance suite.
4. **Platform expansion:** screenshots, additional input, clipboard, app lifecycle,
   other OS backends, and remote Host routing only after each capability's tests and
   support statement pass.

No phase may publish a private Host API used only by the official plugin. A new
contribution point and its first-party consumer ship together with CLI validation,
Host inspection, real UI/agent consumption, author documentation, and test harness
coverage.

## 12. Open questions

1. Which desktop platforms and environments are first-release supported, and what
   exact manual E2E matrix is required for release?
2. Should grants be attributed to plugin identity and revoked when that plugin is
   disabled, or should grants belong only to the local user/Host and survive plugin
   lifecycle changes? This draft proposes revoking plugin-originated grants on
   disable.
3. What default and maximum grant TTLs balance continuity with least exposure?
4. Should clipboard support be included in the first release or deferred entirely?
5. Which Host-rendered status/picker contribution point is the intended UX surface?
   Current SDK contribution kinds do not expose a persistent privileged Host status
   surface.
6. What policy governs audit retention and user export/deletion?
7. Does remote operation target only the paired Host desktop, and what pairing and
   local-presence conditions are required?
8. What are the exact per-operation limits for payload size, timeout, rate, and
   concurrency?

## 13. References

- [VibeX v4 package contract](../../plugins/package-v4.md)
- [VibeX Plugin SDK and CLI](../../plugins/sdk-and-cli.md)
- ADR-0046: Full-stack plugin package, isolated SDK, and Host lifecycle
- ADR-0047: Product-centric plugin package and content model
- ADR-0048: Full Trust execution model
- ADR-0051: Host-managed plugin-scoped MCP runtimes
- ADR-0061: Host-local safety and performance baseline
- ADR-0066: Marketplace, authoring, and session honesty
- ADR-0069: Plugin platform and unprivileged official plugins
- ADR-0078: Host command registry as the single seam
- ADR-0081: Connect-time session binding and codeg parity
