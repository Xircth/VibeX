# RU-002 Browser URL Contract Test Plan

## Scope

- `crates/utils/src/browser.rs`
- `docs/problemmap/rust-utils.md`
- `docs/problemmap/README.md`

## Smell

`validate_browser_url` still has a historical strict character whitelist. RU-001 made the PowerShell script static and passes the URL as a process argument, so the whitelist is no longer the script-injection defense. Before changing that boundary, the current accepted and rejected URL forms need explicit tests.

## Behavior Lock

Add tests for:
- Known PR/browser URL shapes accepted by current call sites, including GitHub and Azure DevOps URLs with query/fragment characters from the current whitelist.
- Shell-sensitive or unsupported URL forms rejected, including spaces, quotes, and non-http protocols.

## Cleanup

This pass is test reinforcement only. Do not relax the whitelist yet.

## Verification

- `cargo test -p utils browser --lib`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
