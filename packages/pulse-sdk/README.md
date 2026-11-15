# `@vibex/pulse-sdk`

Typed TypeScript + ESM SDK and CLI for VibeX's AI-Native Event-Driven Automation Engine (**Pulse**).

Zero external runtime dependencies (built on Node 20+ `node:crypto`, `fetch`, and native TypeScript type-stripping).

## Capabilities

- **Typed Wire Contracts (`types.ts`)** — 1:1 TypeScript definitions matching `crates/api-types/src/pulse.rs` (`EventEnvelope`, `GateFilterAst`, `PulseRuleSpec`, `PulseTargetSpec`, `PulseTemporalSpec`, `PresetOrchestratorKind`, `MandateOrigin`, plus Dual-Primitive `SessionStep` and `BotStep` workflow specs).
- **Custom Event Schemas (`defineEvent`)** — Exhaustive (No Fail-Fast) JSON Schema + custom payload validation and monotonic ULID `EventEnvelope` generation.
- **Standard Webhooks (`signStandardWebhook`, `verifyStandardWebhook`)** — Constant-time HMAC-SHA256 verification (`timingSafeEqual`) with 64KiB payload ceiling and 5-minute replay window checked prior to JSON parsing.
- **Fluent Builders (`pulseRule`, `pulseWorkflow`)** — Declarative rule authoring across all 5 receptor kinds (`Session`, `Bot`, `Group`, `User`, `Workflow`) and Dual-Primitive workflows mixing ephemeral `sessionStep` nodes with persistent `botStep` nodes.
- **REST Client (`PulseClient`)** — Speaks `/api/pulse/*` with Bearer / Standard Webhooks HMAC authentication and pluggable transport for unit testing.
- **CLI (`vibex-pulse`)** — `vibex-pulse emit` and `vibex-pulse dry-run`.

## Quick Start

```ts
import {
  defineEvent,
  pulseRule,
  pulseWorkflow,
  PulseClient,
} from '@vibex/pulse-sdk';

const CoverageDropped = defineEvent<{ repo: string; coverage: number }>({
  eventType: 'ci.coverage.dropped',
  summary: 'Emitted when main branch coverage drops below threshold',
  jsonSchema: {
    type: 'object',
    required: ['repo', 'coverage'],
    properties: {
      repo: { type: 'string', minLength: 1 },
      coverage: { type: 'number', minimum: 0, maximum: 100 },
    },
    additionalProperties: false,
  },
});

const rule = pulseRule('Guard test coverage')
  .mode('observe')
  .fromSources('sdk_custom')
  .onEventTypes(CoverageDropped.eventType)
  .notBotActor()
  .whereLt('/coverage', 80)
  .toFreshSession({
    agentId: 'codex',
    workspaceIsolation: 'isolated_worktree',
    subscribeThread: true,
    promptTemplate: 'Coverage in {{repo}} dropped to {{coverage}}%. Add missing tests.',
  })
  .build();
```
