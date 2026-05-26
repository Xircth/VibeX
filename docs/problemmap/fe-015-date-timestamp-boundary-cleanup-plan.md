# FE-015 date timestamp boundary cleanup plan

## Scope

- Files:
  - `frontend/src/utils/date.ts`
  - `frontend/src/utils/date.test.ts`
  - selected frontend hooks/components that sort by `created_at`
- Smell: weak generated-type/runtime boundary, duplication, missing tests.
- Current issue: several call sites sort by `new Date(value as unknown as string).getTime()`. This repeats the same workaround for backend timestamp values that may be typed as `Date` but arrive over JSON as strings.

## Behavior lock first

Add focused unit coverage for a shared timestamp helper:

- ISO strings convert to their millisecond timestamp;
- `Date` objects convert to the same timestamp;
- invalid strings preserve JavaScript `Date` behavior by returning `NaN`.

## Cleanup order

1. Add helper tests.
2. Add `dateTimestamp` to `frontend/src/utils/date.ts`.
3. Replace scattered `as unknown as string` timestamp sorting in selected frontend runtime surfaces.
4. Keep sort direction and invalid-date behavior unchanged.

## Verification

- `pnpm vitest run src/utils/date.test.ts`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
