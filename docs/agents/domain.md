# Domain Docs

How engineering skills consume this repository's domain documentation.

This repository uses a **single-context** layout. The root `CONTEXT.md` defines
the system-wide language for the frontend, Tauri shell, and Rust workspace;
root `docs/adr/` records architectural decisions.

## Before exploring

- Read root **`CONTEXT.md`** first.
- Read every ADR in **`docs/adr/`** that touches the area being changed.
- Use the terminology defined in `CONTEXT.md` for issue titles, plans,
  hypotheses, tests, and implementation notes.

If a required concept is absent, do not casually invent a synonym: identify the
gap and use `/domain-modeling` when the project needs to establish the term.

## File structure

```
/
├── CONTEXT.md                          ← system-wide glossary + agent rules
└── docs/adr/                           ← system-wide decisions
```

Do not create `CONTEXT-MAP.md` or per-module contexts unless the user explicitly
chooses to move to a multi-context layout.

## ADR conflicts

When a proposal contradicts an ADR, surface the conflict rather than silently
overriding it:

> _Contradicts ADR-0002 (single agent-identity enum) — but worth reopening because…_
