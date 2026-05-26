# TAURI-006 Prompt Enhancement Model Fixture Cleanup Plan

## Scope

- `src-tauri/src/commands/config/prompt_enhancement.rs`
- Tauri command ProblemMap documentation.

## Smell

The `parse_opencode_models` unit test uses a corrupted stdout fixture containing
mojibake and a damaged newline marker. The parser behavior is useful, but the
fixture no longer communicates the real contract it protects.

## Behavior Lock

1. Run `cargo test -p vibex parses_opencode_models_from_stdout_lines --lib`
   before editing.
2. Keep the same expected parsed model list after replacing the fixture.
3. Run the targeted test again, then Tauri/backend and full repo gates.

## Cleanup Order

1. Replace the corrupted fixture line with readable representative stdout that
   still contains punctuation around an `opencode/...` token.
2. Confirm no mojibake remains in the prompt enhancement test fixture.
3. Update ProblemMap evidence.

## Explicit Non-Goals

- Do not change `parse_opencode_models` behavior.
- Do not change default model lists.
- Do not change prompt enhancement runtime behavior.
