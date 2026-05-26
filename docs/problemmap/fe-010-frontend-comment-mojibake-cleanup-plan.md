# FE-010 Frontend Comment Mojibake Cleanup Plan

## Scope

- `frontend/src/hooks/useLogStream.ts`
- `frontend/src/stores/useTerminalStore.ts`

## Problem

Two frontend comments contain mojibake around punctuation. They do not affect
runtime behavior, but they reduce maintainability in the log-stream and terminal
session metadata surfaces.

## Behavior Lock

This pass is comment-only. Lock the scope with:

- targeted grep before and after the edit
- TypeScript check
- ESLint
- full repository check/lint
- whitespace check

## Cleanup Steps

1. Replace the corrupted punctuation in both comments with readable ASCII text.
2. Do not alter runtime code, types, or component behavior.
3. Update ProblemMap documentation and verification ledger.
