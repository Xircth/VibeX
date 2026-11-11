---
name: maiden-skill
description: Project-wide engineering principles and anti-bloat gate governance for VibeX. Use this skill at the start of every task, before analysis, design, implementation, testing, or release, to keep solutions complete, root-cause-driven, clean, deployment-consistent, non-fail-fast, and free of governance bloat or redundant UI copy.
---

# Maiden Principles

Treat the work as if it were being created for the first time: one clear source of truth, a complete working outcome, and no accumulated workaround debt.

## Principles

1. **First principles and complete usability** — Start from the user-visible capability and its full path. Functional usability and completeness are the highest drivers; do not preserve an implementation, abstraction, or plan that prevents the feature from working end to end.
2. **Fix the root cause** — Trace a defect or inconsistency to its origin and correct the design there. Do not paper over it with special cases, copied legacy logic, extra switches, or route-specific exceptions.
3. **Make code explain itself** — Names express what code does. Comments record why a decision exists or a business rule requires it; remove comments that merely restate the code.
4. **Leave no residue** — Do not retain backup files, obsolete code, stale documentation, commented-out experiments, or incorrect intermediate states. Correct or remove them.
5. **Keep deployments identical** — Treat local source and deployed source as the same artifact. Do not make untracked server-only changes; verify integrity when the delivery process supports it.
6. **Keep UI concise and jitter-free** — Every visible string must help the user act, decide, understand current state, recover from an error, or safely assess a consequence. Do not add implementation notes, redundant feature descriptions, or decorative hints (for example, do not explain that Settings is configured through `settings.json`). Apply `font-variant-numeric: tabular-nums` (`tabular-nums`) to all column-aligned or dynamically changing numbers (timers, progress percentages, counters, token/price metrics, table cells) while keeping static prose digits proportional.

## Engineering Gate & Anti-Bloat Rules

1. **Exhaustive error reporting (No Fail-Fast)** — Every static check, manifest validator, schema parser, and gate script (`scripts/check-*.mjs`, CLI validators) must traverse the full target set and report **all** violations in a single pass. Never throw or exit on the first violation: finding `N` defects must take 1 agent turn, never `N` turns.
2. **Check replacement budget (Every budget is a trade, not a ceiling)** — Blocking gate suites are capped at **6 checks** (total budget ≤ 65 seconds). Adding a new blocking check requires merging into an existing rule or retiring a lower-value check so CI and pre-merge gates never bloat.
3. **Asymmetric apparatus rule** — Agents may freely delete redundant helper scripts, dead wrappers, and obsolete scaffolding without asking, but **must never add** any new governance script, wrapper script, or standalone lint/gate configuration file without explicit human approval.
4. **File size ceiling (1,500 lines)** — Keep individual source files at or below 1,500 lines. Split growing modules along clean domain seams rather than accumulating monoliths.

## Apply before acting

Before proposing or making changes, check:

- Does this produce the complete usable capability, including the necessary paths and failure states?
- Am I addressing the source of the problem rather than adding a workaround?
- Can any code, helper script, documentation, or UI text be removed because it is redundant, stale, or implementation-facing?
- Do all validation and gate paths collect and return every violation in one run instead of failing on the first error?
- Am I extending existing gates/modules within the replacement budget rather than introducing unapproved governance scripts or wrappers?

When principles conflict, preserve correct, complete user functionality first; then choose the smallest clean design that keeps a single source of truth.

