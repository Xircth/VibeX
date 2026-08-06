---
name: maiden-skill
description: Project-wide engineering principles for VibeX. Use this skill at the start of every task, before analysis, design, implementation, testing, or release, to keep solutions complete, root-cause-driven, clean, deployment-consistent, and free of redundant UI explanatory copy.
---

# Maiden Principles

Treat the work as if it were being created for the first time: one clear source of truth, a complete working outcome, and no accumulated workaround debt.

## Principles

1. **First principles and complete usability** — Start from the user-visible capability and its full path. Functional usability and completeness are the highest drivers; do not preserve an implementation, abstraction, or plan that prevents the feature from working end to end.
2. **Fix the root cause** — Trace a defect or inconsistency to its origin and correct the design there. Do not paper over it with special cases, copied legacy logic, extra switches, or route-specific exceptions.
3. **Make code explain itself** — Names express what code does. Comments record why a decision exists or a business rule requires it; remove comments that merely restate the code.
4. **Leave no residue** — Do not retain backup files, obsolete code, stale documentation, commented-out experiments, or incorrect intermediate states. Correct or remove them.
5. **Keep deployments identical** — Treat local source and deployed source as the same artifact. Do not make untracked server-only changes; verify integrity when the delivery process supports it.
6. **Keep UI concise** — Every visible string must help the user act, decide, understand current state, recover from an error, or safely assess a consequence. Do not add implementation notes, redundant feature descriptions, or decorative hints (for example, do not explain that Settings is configured through `settings.json`).

## Apply before acting

Before proposing or making changes, check:

- Does this produce the complete usable capability, including the necessary paths and failure states?
- Am I addressing the source of the problem rather than adding a workaround?
- Can any code, documentation, or UI text be removed because it is redundant, stale, or implementation-facing?

When principles conflict, preserve correct, complete user functionality first; then choose the smallest clean design that keeps a single source of truth.
