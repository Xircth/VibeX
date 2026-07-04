# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **multi-context**: `frontend/` and each Rust crate under `crates/*` are distinct contexts with their own domain language (e.g. the ACP agent runtime, the event-sourced conversation core, worktree/workspace management).

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic. (This file is created lazily; if it's absent, fall back to the root `CONTEXT.md`.)
- **`CONTEXT.md`** at the repo root — the system-wide glossary and starting point.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. For a context-scoped decision, also check that context's own `docs/adr/` (e.g. `crates/<crate>/docs/adr/` or `frontend/docs/adr/`) if it exists.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Multi-context layout for this repo (`CONTEXT-MAP.md` at the root is the entry point once it exists):

```
/
├── CONTEXT.md                          ← system-wide glossary + starting point
├── CONTEXT-MAP.md                      ← (lazy) points at each context's CONTEXT.md
├── docs/adr/                           ← system-wide decisions
├── frontend/
│   └── (optional) CONTEXT.md, docs/adr/
└── crates/
    ├── agents/
    │   └── (optional) CONTEXT.md, docs/adr/
    └── conversations/
        └── (optional) CONTEXT.md, docs/adr/
```

Today the repo has a single root `CONTEXT.md` and root `docs/adr/`; per-context `CONTEXT.md` files and `CONTEXT-MAP.md` are added lazily by `/domain-modeling` as contexts accrue their own vocabulary.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0002 (single agent-identity enum) — but worth reopening because…_
