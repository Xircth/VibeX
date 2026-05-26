# FE-009 cn Tailwind Merge Cleanup Plan

## Scope

- `frontend/src/lib/utils.ts`
- `frontend/src/lib/utils.test.ts`

## Problem

`cn()` imports only `clsx` while `tailwind-merge` is installed and expected by
the local UI component pattern. The disabled import and stale TODO claim that
merge should wait for Tailwind v4, but the project currently uses Tailwind 3.4
with `tailwind-merge` 2.6 already present in the lockfile.

## Behavior Lock

Add focused `cn()` assertions before changing implementation:

- standard Tailwind conflicts collapse to the later class, e.g. `p-2 p-4`
- custom color tokens can coexist with size tokens, e.g. `text-low text-base`

## Cleanup Steps

1. Add failing tests for conflict merging and custom-token preservation.
2. Restore the `tailwind-merge` import and return `twMerge(clsx(inputs))`.
3. Delete the stale TODO and commented-out implementation.
4. Run the focused test, frontend typecheck/lint, full repo check/lint, and
   whitespace check.

## Non-Goals

- Do not change Tailwind config.
- Do not add dependencies.
- Do not rewrite individual call sites.
