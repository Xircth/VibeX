# TAURI-005 Process Launch Cleanup Plan

## Scope

- Keep this pass focused on command-layer process construction drift.
- Do not replace already-centralized `utils::process::new_hidden_*` call sites.
- Do not change user-visible notification sound behavior.

## Behavior Locks

- Extend `crates/utils/src/process.rs` tests so the hidden-command builders cover
  normal executable paths as well as Windows batch wrappers.
- Keep the existing Windows batch-with-spaces tests as the regression guard for
  `.cmd`/`.bat` launcher behavior.

## Edit Plan

1. Use `utils::process::new_hidden_tokio_command` for notification sound player
   launches in `src-tauri/src/commands/config.rs`.
2. Preserve the existing platform order:
   - macOS: `afplay`
   - Linux non-WSL: `paplay`, falling back to `aplay`
   - Windows and WSL: `powershell.exe` `Media.SoundPlayer`
3. Keep process errors intentionally ignored because `play_notification_sound`
   currently returns success even when audio playback cannot start.

## Verification

- `cargo test -p utils process --lib`
- `cargo check -p vibex`
- `pnpm run check`
- `pnpm run lint`

## Pass 2: Process Output Error Detail

### Scope

- Keep this pass limited to repeated command-output detail extraction.
- Do not change which commands run, their arguments, or their success behavior.
- Preserve existing user-facing fallback text when stderr/stdout are empty.

### Behavior Locks

- Add `utils::process` tests for command failure detail extraction:
  - stderr wins over stdout
  - stdout is used when stderr is empty
  - empty stderr/stdout returns no detail

### Edit Plan

1. Add a small `command_output_detail` helper in `utils::process`.
2. Replace duplicated stderr/stdout extraction in:
   - `src-tauri/src/commands/workspaces/workspace_scripts.rs`
   - `src-tauri/src/commands/system_maintenance.rs`
   - `src-tauri/src/commands/agent_settings.rs`
3. Leave provider/runtime-specific process handling alone unless it uses the
   same fallback policy.
