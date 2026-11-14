# Companion & Paired Remote Clients

VibeX clients — **native iOS Companion** ([`mobile/ios`](../../mobile/ios), [ADR-0084](../adr/0084-native-swiftui-ios-companion.md)), **native Android Companion** ([`mobile/android`](../../mobile/android), [ADR-0041](../adr/0041-native-kotlin-compose-android-companion.md)), and **paired Remote Desktop Workstations** ([ADR-0054](../adr/0054-host-family-distribution-and-client-surfaces.md)) — connect to an online **VibeX Host** (`vibex` Desktop or `vibex-server`) over **Remote Protocol v1** ([`docs/protocol/v1/README.md`](../protocol/v1/README.md)).

Mobile Companions never execute coding agents, Git worktrees, PTY shells, or plugin workers on the phone; all compute stays on the Host while Companions observe live timelines, answer approvals/questions, steer or launch turns, and read offline caches.

---

## 1. Host Identity, Pairing Invitations & Device Presets

Defined by [ADR-0059](../adr/0059-host-identity-and-pairing-invitation.md) and [`crates/remote-protocol`](../../crates/remote-protocol):

1. **Stable `HostIdentity`**: Clients identify a Host by its cryptographic/persistent `host_id` exposed during pairing and `/api/v1/capabilities`, never by a raw IP or tunnel URL. Multiple URLs (LAN, Tailscale, Cloudflare/FRP, SSH tunnel, or WebRTC signaling relay) merge as `Reachability` entries under a single `ServerProfile`.
2. **Pairing Invitation**: Generated from the Host Console (`Settings → Remote Access` or CLI). Contains `host_id`, display metadata, active non-loopback `Reachability` origins, a **Device Permission Preset** (`Companion Device` or `Workstation Device`), and a short-lived, single-redeem pairing secret.
3. **Long-Lived Device Credential**: Redeeming the invitation issues a dedicated, revocable device token stored in OS secure storage (iOS Keychain / Android Keystore / Desktop credential store). Rotating the server admin token or expiring the invitation never disconnects already-paired devices; revoking a device in Host Console drops its HTTP and WebSocket access immediately.

| Preset | Target Surface | Permitted Capabilities |
| --- | --- | --- |
| **Companion Device** | `mobile/ios` (SwiftUI), `mobile/android` (Kotlin/Compose) | Browse projects/workspaces/conversations (`conversation.read`), create/send/steer/cancel turns, approve/deny permissions, answer structured questions, inspect read-only Artifacts, and read local offline cache. Excludes PTY terminals, plugin installation, and Host administration. |
| **Workstation Device** | Paired Desktop `vibex` (`RemoteDesktopTransport`) | Full remote coding loop: conversations, files, diffs, Git, PTY terminals, DAG Workflows, Automations, and installed plugin surfaces over HTTPS/WS or E2EE WebRTC (`vibex-webrtc://`). Excludes Host Console administration (listener bind, pairing issuance, device revocation, binary upgrade). |

---

## 2. Conversation Event Authority & Durable WebSocket Attach

All remote clients consume the same event-sourced conversation pipeline (`ConversationControl` → `conversation_events` → `Projection` → `Remote Protocol v1`):

### Capability Handshake & WebSocket Subprotocol

1. **Handshake**: `GET /api/v1/capabilities` verifies protocol compatibility (`protocol_version: 1`), resolves `host_id`, and returns the exact command/scope set derived from `HostCommandRegistry` ([ADR-0078](../adr/0078-host-command-registry-single-seam.md)).
2. **WebSocket Authentication**: Connect to `/api/v1/ws` passing the device credential in `Sec-WebSocket-Protocol: vibex.token.<base64url>` (query-string tokens are rejected).
3. **Durable Attach Lifecycle**:
   - Client sends `attach` for a `conversation_id` with optional `after_sequence` (its highest persisted event sequence).
   - Host replies `ready`, streams either incremental `event` frames (replay) or a full materialized `snapshot` when `after_sequence` falls behind retention, emits high-water `live` once caught up, and streams real-time updates thereafter (`detached` closes the subscription).
   - Clients deduplicate by `sequence` and must ignore or preserve unknown future `event` variants without crashing.

### Timeline Row Folding & Read-Only Offline Cache

- Conversation streams fold into monotonic **`TimelineRow`** items keyed by `(row_id, revision)`. Updating a streaming assistant message, tool call card, diff preview, or permission prompt increments `revision` on the existing `row_id` for idempotent in-place UI rendering.
- **Offline Conversation Cache**: Companions persist recent conversation catalog metadata, `sequence` watermarks, and folded rows locally. Whenever disconnected, cached views explicitly set `read_only = true` — clients never silently queue offline writes.

### Idempotent Write Commands

Every mutating Companion action (`conversation.send_input`, `conversation.steer_turn`, `conversation.cancel_turn`, `conversation.respond_permission`, `conversation.respond_question`, `conversation.create`) carries a client-generated UUID **`operation_id`**:

- Retrying the same `operation_id` across flaky mobile networks returns the original outcome instead of duplicating prompts or double-answering approvals.
- Approvals and question answers race safely against Desktop and IM Chat Channels on the same Host event log — whichever authorized surface responds first resolves the pending prompt across all connected devices.

---

## 3. Client Connection State Machine

Both `mobile/ios` and `mobile/android` implement the same five-state connection model:

```text
connecting ──► online ◄──► recovering ──► offline (read-only cache)
    │
    ├──► auth_required (401 / device revoked — prompt re-pair)
    └──► incompatible  (protocol mismatch — prompt app/Host update)
```

## 4. Related Specifications

- **Wire Schemas & OpenAPI**: [`docs/protocol/v1/README.md`](../protocol/v1/README.md) (`openapi.json`, `ws-client-frame.schema.json`, `ws-server-frame.schema.json`)
- **Architecture & Single-Seam Host**: [`docs/architecture.md`](../architecture.md), [ADR-0054](../adr/0054-host-family-distribution-and-client-surfaces.md), [ADR-0059](../adr/0059-host-identity-and-pairing-invitation.md), [ADR-0078](../adr/0078-host-command-registry-single-seam.md)
- **Native Companion Implementations**: [`mobile/ios/`](../../mobile/ios/) ([ADR-0084](../adr/0084-native-swiftui-ios-companion.md)) & [`mobile/android/`](../../mobile/android/) ([ADR-0041](../adr/0041-native-kotlin-compose-android-companion.md))
