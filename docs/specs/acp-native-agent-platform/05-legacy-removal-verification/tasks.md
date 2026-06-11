# Tasks: Legacy Runtime Removal And Verification

- [x] Task: Delete provider runtime backend.
  - Acceptance: `src-tauri/src/commands/provider_runtime/**` is gone and command
    registration compiles without it.
  - Verify: `rg "provider_runtime" src-tauri`; `pnpm run backend:check`
  - Files: `src-tauri/src/commands/**`, generated type exports.

- [x] Task: Delete provider runtime frontend.
  - Acceptance: No frontend imports provider runtime adapters, panel, or API.
  - Verify: `rg "provider-runtime|ProviderRuntime|sendProviderRuntimeTurn" frontend/src`
  - Files: frontend provider-runtime modules and replacement imports.

- [x] Task: Delete SDK bridge scripts and package dependencies.
  - Acceptance: Bridge scripts are gone and package metadata no longer installs
    bridge-only SDK dependencies.
  - Verify: `rg "claude-agent-sdk-provider|opencode-sdk-provider|@anthropic-ai/claude-agent-sdk|@opencode-ai/sdk" .`
  - Files: `scripts/**`, `package.json`, lockfile.

- [x] Task: Remove old ACP executor runtime.
  - Acceptance: `crates/executors` no longer owns ACP live runtime code.
  - Verify: `cargo check -p executors`; `rg "AcpBackedExecutor|AcpAgentHarness" crates`
  - Files: `crates/executors/**`.

- [x] Task: Replace tests and generated types.
  - Acceptance: Tests assert new Agent runtime behavior; old provider-runtime
    tests are deleted.
  - Verify: `pnpm run generate-types:check`; `cargo test --workspace`
  - Files: tests across Rust and frontend.

- [ ] Task: Final full verification.
  - Acceptance: Static search gates and full check/lint/build gates pass.
  - Verify: commands listed in `design.md`.
  - Files: entire repository.
