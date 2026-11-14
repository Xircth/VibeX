# VibeX Documentation Index

Welcome to the VibeX documentation hub. Every document here describes **current `v0.4.x` behavior or a permanent architectural contract** — ephemeral scratch notes, historical QA waves, and completed migration trackers are intentionally excluded.

## 1. Product, Design & Domain Model

| Document | Purpose |
| --- | --- |
| [`README.md`](../README.md) / [`README.zh-CN.md`](../README.zh-CN.md) | Product introduction: Agent-Native development platform & Vibe Coding toolkit overview, key capabilities, screenshots, and quick start. |
| [`PRODUCT.md`](../PRODUCT.md) | Product charter: Agent-Native development platform positioning, target users, anti-references, and product design principles. |
| [`DESIGN.md`](../DESIGN.md) | Single source of truth for frontend visual design (macOS Tahoe Liquid-Glass chrome + opaque content surfaces, tokens, dark/night palettes, typography). |
| [`CONTEXT.md`](../CONTEXT.md) | Ubiquitous Language glossary across Conversation, Collaboration Space, Channel, Automation, Workflow, Plugin/Artifact, Remote/Device, and Agent domains. |

## 2. System Architecture, Remote Protocol & Deployment

| Document | Purpose |
| --- | --- |
| [`docs/architecture.md`](architecture.md) | End-to-end system architecture: Single-Seam Host (`ApplicationCore` + `HostCommandRegistry` + `HostEventBus`), Dual-Stage Workbench, Dedicated-Engine-first `AgentRuntime` (with ACP fallback), Collaboration Space identity, DAG Workflows, Plugin Kernel, and 26-crate Cargo workspace map. |
| [`docs/protocol/v1/README.md`](protocol/v1/README.md) | Versioned Remote Protocol v1 OpenAPI & JSON Schemas (`/api/v1/capabilities`, `/api/v1/commands/{command}`, `/api/v1/ws` durable attach). |
| [`docs/companion/README.md`](companion/README.md) | Companion & Remote Client guide: pairing invitations, durable WebSocket attach/fold contract, idempotent writes, and native iOS (`mobile/ios`) & Android (`mobile/android`) apps. |
| [`docs/deployment/headless-server.md`](deployment/headless-server.md) | `vibex-server` headless deployment, `@omnione/vibex` CLI (`serve`, `list`, `install`), Docker Compose, security boundaries, upgrades, and operational runbook. |

## 3. Plugin Platform v4 (`Everything is a Plugin`)

| Document | Purpose |
| --- | --- |
| [`docs/plugins/README.md`](plugins/README.md) | Entry point for plugin users, authors, and platform contributors. |
| [`docs/plugins/user-guide.md`](plugins/user-guide.md) | Installing, enabling, configuring, updating, and removing plugins via UI or `vibex plugin` CLI. |
| [`docs/plugins/developer-guide.md`](plugins/developer-guide.md) | Authoring full-trust v4 packages with `@vibex/plugin-sdk` (`^2.0.0`), Python/Rust Worker SDKs, `vibex-plugin` CLI, and live `--dev` linking. |
| [`docs/plugins/official-plugins.md`](plugins/official-plugins.md) | Reference guide to VibeX's 17 official plugins (`plugins/*` & `vibex-plugin.json`) and built-in Collaboration Space. |
| [`docs/plugins/package-v4.md`](plugins/package-v4.md) | Normative `.vibex-plugin/plugin.json` v4 package layout, `README.md` summary frontmatter, `contents/`, `depends/`, and `config.json`. |
| [`docs/plugins/sdk-and-cli.md`](plugins/sdk-and-cli.md) | `@vibex/plugin-sdk` API surface, `vibex-plugin` author CLI commands, and linked development workflow. |
| [`docs/plugins/platform-architecture.md`](plugins/platform-architecture.md) | Plugin Kernel internals: Activation Generations, Runtime locks, Full-Trust Worker/App surfaces, and Remote Host execution seam. |
| [`docs/plugin-contract/bindings.md`](plugin-contract/bindings.md) | Generated contract matrix of the 23 contribution kinds (`L0`–`L3`) and Host API permissions. |

## 4. Subsystems, ADRs, Security & Releases

| Location | Purpose |
| --- | --- |
| [`docs/specs/`](specs/) | Active cross-cutting technical specifications (`agent-capability-catalog.md`, `codex-native-provider-app-server-alignment.md`, `context-menu-surfaces.md`, `prepared-acp-session-controls.md`, `session-runtime-placement.md`). |
| [`docs/adr/`](adr/) | Architectural Decision Records (`ADR-0001` through `ADR-0086`) — immutable record of design decisions and supersession notes. |
| [`docs/agents/`](agents/) | Local `.scratch/` issue tracker conventions (`issue-tracker.md`, `triage-labels.md`) used by repository automation skills. |
| [`docs/security/dependency-license-audit.md`](security/dependency-license-audit.md) | Dependency license gate (`pnpm run dependency:licenses`) and supply-chain audit policy. |
| [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) & [`docs/third-party/`](third-party/) | Open-source attributions, vendored skill notices, and clean-room adoption provenance. |
| [`docs/release/`](release/) | Versioned release notes (`0.1.2.md` – `0.4.4.md`) consumed by GitHub Release pipelines. |
| [`AGENTS.md`](../AGENTS.md) / [`CLAUDE.md`](../CLAUDE.md) | Engineering bootstrap, commands, coding conventions, and architectural invariants for contributors and coding agents. |

## Documentation Hygiene Rule

- **Single source of truth**: Domain definitions belong in [`CONTEXT.md`](../CONTEXT.md); architectural decisions belong in [`docs/adr/`](adr/); visual rules belong in [`DESIGN.md`](../DESIGN.md). Do not duplicate them across ad-hoc markdown files.
- **Ephemeral plans (`docs/plans/`)**: Only active, in-progress implementation plans belong in `docs/plans/`. Once a feature lands, fold durable contracts into [`CONTEXT.md`](../CONTEXT.md), [`docs/architecture.md`](architecture.md), or an ADR, and delete the finished plan. Never commit QA screenshot dumps or per-wave audit logs into `docs/`.
