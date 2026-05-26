# ProblemMap: Rust Utils

Scope: `crates/utils/**`, with completed cleanup passes covering the WSL2 browser launch path, browser URL validation contract, and process command construction boundaries.

## Problems

### RU-001: WSL browser launch embeds URL into PowerShell script

- Category: weak boundary, complex implementation, missing tests
- Severity: high
- Confidence: high
- Files: `crates/utils/src/browser.rs`
- Evidence: the previous WSL path built the PowerShell script with `format!("Start-Process '{url}'")`. Even with URL character validation, this mixed user-derived data into shell-language text and required the reader to trust quoting and the whitelist together.
- Behavior that must remain: WSL2 still opens `http://` and `https://` URLs through PowerShell, rejects non-http protocols, and keeps Windows popup suppression via `configure_tokio_command_no_window`.
- Cleanup status: fixed in this pass.
- Fix: split command construction into `wsl_browser_command_parts`, keep the PowerShell script static, and pass the URL as `$args[0]`.
- Behavior lock: added tests that prove the URL is not embedded in the PowerShell script and non-http protocols are rejected.
- Verification: `cargo test -p utils browser --lib`; `pnpm run check`.

### RU-002: URL validation name and contract are narrower than the implementation intent

- Category: historical baggage, weak boundary
- Severity: medium
- Confidence: medium
- Files: `crates/utils/src/browser.rs`
- Evidence: `validate_browser_url` still carries the historical strict URL whitelist even though, after RU-001, the URL is passed as a separate process argument rather than embedded into PowerShell script text. The whitelist may reject valid URLs that could now be passed safely as an argument.
- Cleanup status: behavior contract locked in this pass; whitelist relaxation remains deferred.
- Plan: [ru-002-browser-url-contract-plan.md](ru-002-browser-url-contract-plan.md) documents the test-only contract pass.
- Behavior lock: added tests for current accepted GitHub, Azure DevOps, and localhost URL forms with query/fragment characters, plus rejected spaces, quotes, backticks, and non-http protocols.
- Verification: `cargo test -p utils browser --lib` passed with 4 tests; `pnpm run check`; `pnpm run lint`.

### RU-003: Process helpers carry platform-specific behavior that needs broader boundary tests

- Category: missing tests, weak boundary
- Severity: medium
- Confidence: medium
- Files: `crates/utils/src/process.rs`
- Evidence: Windows-specific no-window and batch-script behavior was mostly protected under `#[cfg(all(test, windows))]`, while cross-platform command construction behavior had limited test coverage.
- Cleanup status: fixed in this pass.
- Plan: [ru-003-process-command-construction-plan.md](ru-003-process-command-construction-plan.md) documents the test-only boundary reinforcement and keeps Windows `.cmd` runtime behavior under the existing Windows-only tests.
- Behavior lock: added platform-neutral tests that prove `new_hidden_std_command` and `new_hidden_tokio_command` preserve the requested program and all arguments in order for ordinary executables; existing Windows runtime tests still prove `.cmd` wrapping.
- Verification: `cargo test -p utils process --lib` passed with 9 tests; `pnpm run check`; `pnpm run lint`.

## Deferred Findings

### RU-002 follow-up: URL whitelist relaxation remains an intentional product/security decision

- Category: weak boundary, uncertainty
- Severity: low-medium
- Confidence: medium
- Files: `crates/utils/src/browser.rs`
- Evidence: the current accepted/rejected URL contract is now explicitly tested, but no call-site evidence yet proves that broader valid URL characters are required.
- Recommended next step: relax the whitelist only after a concrete rejected-but-needed browser URL form is identified from call sites or user reports.

## Uncertainties

- None blocking for RU-001. RU-002 should not be changed further until accepted/rejected URL forms are specified or discovered from call sites.
