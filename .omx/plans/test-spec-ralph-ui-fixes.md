# Test Spec: Ralph UI Fixes

## Verification targets

### Conversation rendering
- Add or update focused frontend tests around existing-session follow-up behavior if coverage is missing.
- Confirm ongoing execution entries become visible before completion.

### Chinese copy
- Verify touched UI labels render expected Chinese text.

### File-tree menu
- Add or update a component test for the grouped `复制` submenu if the file already has test coverage nearby; otherwise validate through targeted render assertions where practical.
- Confirm duplicate / relative path / absolute path handlers remain wired.

### Usage statistics
- Add or update unit-level coverage for corrected aggregation/filter logic where practical.
- Validate dashboard-derived values remain consistent for totals, date filtering, and sorting.

## Regression commands
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- Targeted frontend tests for touched components/hooks
- Additional project checks if backend usage-statistics code changes are required
