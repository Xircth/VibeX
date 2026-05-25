# ProblemMap: Rust Utils

Scope: `crates/utils/**`, with the first cleanup pass focused on the WSL2 browser launch path in `crates/utils/src/browser.rs`.

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

## Deferred Findings

### RU-002: URL validation name and contract are narrower than the implementation intent

- Category: historical baggage, weak boundary
- Severity: medium
- Confidence: medium
- Files: `crates/utils/src/browser.rs`
- Evidence: `validate_browser_url` still carries the historical strict URL whitelist even though, after RU-001, the URL is passed as a separate process argument rather than embedded into PowerShell script text. The whitelist may reject valid URLs that could now be passed safely as an argument.
- Recommended next step: add explicit tests for accepted URL forms before relaxing or changing the whitelist.

### RU-003: Process helpers carry platform-specific behavior that needs broader boundary tests

- Category: missing tests, weak boundary
- Severity: medium
- Confidence: medium
- Files: `crates/utils/src/process.rs`
- Evidence: Windows-specific no-window and batch-script behavior is mostly protected under `#[cfg(all(test, windows))]`, while cross-platform command construction behavior has limited test coverage.
- Recommended next step: add platform-neutral tests for argument preservation in `new_hidden_tokio_command` and `new_hidden_std_command`, then keep Windows runtime tests for actual `.cmd` execution.

## Uncertainties

- None blocking for RU-001. RU-002 should not be changed further until accepted/rejected URL forms are specified or discovered from call sites.
