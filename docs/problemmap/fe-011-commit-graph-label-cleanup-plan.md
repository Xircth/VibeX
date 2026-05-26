# FE-011 Commit Graph Presentation Cleanup Plan

## Scope

- `frontend/src/components/git/CommitGraph.tsx`
- `frontend/src/components/git/commitGraphPresentation.ts`
- `frontend/src/components/git/commitGraphPresentation.test.ts`

## Problem

`CommitGraph.tsx` embeds user-visible labels and relative-time formatting inside
the graph component. The copy is currently valid UTF-8, but the presentation
contract is not directly testable and can regress without a focused behavior
lock.

## Behavior Lock

Add focused presentation tests before changing the component:

- graph labels expose readable Chinese strings
- relative time formats seconds, minutes, hours, and days from Unix timestamps
- timestamps older than one week fall back to locale date formatting

## Cleanup Steps

1. Add a failing test for the missing presentation helper.
2. Extract labels and relative-time formatting into a small helper module.
3. Update `CommitGraph.tsx` to use the helper without changing query, lane, SVG,
   click, or panel behavior.
4. Run focused tests, frontend checks, full checks, and targeted mojibake grep.

## Non-Goals

- Do not implement commit-specific diff panels.
- Do not alter commit graph lane assignment or query behavior.
