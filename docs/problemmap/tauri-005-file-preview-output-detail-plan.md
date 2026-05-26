# TAURI-005 File Preview Output Detail Cleanup Plan

## Scope

- Keep this pass limited to file-tree document preview command failure messages.
- Do not change preview extractor commands, arguments, startup-error mapping, or invalid UTF-8 mapping.
- Do not fold provider-runtime SDK errors into this pass; those need their own module-owned tests.

## Behavior Locks

- Add file-preview unit coverage for preview extractor failure messages:
  - stderr detail is included when present
  - stdout detail is used when stderr is empty
  - empty stderr/stdout keeps the existing generic fallback

## Edit Plan

1. Add a small file-preview message helper for failed preview extractor output.
2. Reuse `utils::process::command_output_detail` inside that helper.
3. Wire `run_hidden_utf8_command` through the helper while preserving existing `AppError::BadRequest` shape.

## Verification

- `cargo test -p vibex preview_extraction_failure_message --lib`
- `cargo test -p vibex file_tree --lib`
- `cargo test -p utils command_output_detail --lib`
- `cargo fmt --check`
- `cargo check -p vibex`
- `pnpm run check`
- `pnpm run lint`
