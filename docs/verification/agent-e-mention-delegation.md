# Agent E: Agent Mention and Delegation verification

## Scope and source state

- Worktree: `.worktrees/plugin-v2-tool-runtime`
- Branch: `codex/plugin-v2-tool-runtime`
- Agent E start SHA: `59c657bca5e3759491b6beec18d5a0354cbc753a`
- Recorded `master` SHA: `16d57232d2956d342c8a57afda01ca6c70c8f863`
- The worktree was clean before Agent E changes.

The implementation reuses the canonical controlled composer string and
`BackendTransport` seams. It does not introduce another PromptBlock protocol or
infer delegation from unstructured backend text.

## RED/GREEN log

| Seam                           | RED observation                                                                              | GREEN behavior                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mention boundary and selection | The composer had no Agent Mention provider or `&` typeahead option.                          | A catalog-backed selection inserts `[&Name](vibex://agent/<kind>)`.                                                                                    |
| Non-trigger contexts           | The first matcher accepted `&` inside fenced code.                                           | Ordinary `A&B`, URLs, escaped text, inline code, and fenced code do not open the selector.                                                             |
| Copy and display-name changes  | A rendered chip copied presentation text and did not refresh when the catalog label changed. | Copy returns the stable source URI; presentation follows the current catalog while `agent_kind` stays stable.                                          |
| Companion capability           | The composer did not query the parent binding.                                               | An unsupported parent gets an explicit localized capability hint; a Mention alone never creates a running card.                                        |
| Parent/capability switch       | A new conversation could retain the previous parent's unsupported state.                     | Every conversation switch resets to unknown before reading the new persisted binding capability.                                                       |
| Code-context paste             | Stable URIs in code became chips, and fence-like content could close a fence incorrectly.    | Trigger and URI parsing share a guard for inline, indented, fenced, and fence-like code content.                                                       |
| Delegation cancellation        | The card and projection treated every error result as failed.                                | `canceled`, `cancelled`, and `request_cancelled` rebuild as a persisted canceled projection and render a distinct canceled card.                       |
| Desktop journey                | No user-level two-Mention recovery fixture existed.                                          | A fake MCP-capable `BackendTransport` creates two child projections, completes one, cancels one, navigates to a child, and restores both after reload. |

Tests observe the DOM, serialized composer value, transport calls, and
conversation projection. They do not inspect Lexical or Zustand internals.

## Desktop journey evidence

The component-level fixture is served by the normal frontend Vite runtime from
`frontend/e2e/agent-e/index.html` and mounts the production
`SessionComposerInput`, `AgentMentionProvider`, and `DelegationCard` against a
fake MCP-capable `BackendTransport`.

- [Full WebM recording](agent-e-assets/agent-e-two-mentions.webm)
- [Mentions before send](agent-e-assets/01-mentions-before-send.png)
- [One completed and one canceled child](agent-e-assets/02-success-canceled.png)
- [Child Conversation navigation](agent-e-assets/03-child-navigation.png)
- [Projection restored after refresh](agent-e-assets/04-refresh-restored.png)

macOS does not provide a supported `tauri-driver` WebDriver backend. The
repeatable desktop-journey fixture therefore runs the real React desktop
components in Chromium with the backend boundary faked. Native Tauri adapter
coverage remains in the Rust and transport test suites.

This is partial T2.8 evidence: the fixture proves the frontend journey and
public transport contract, but its localStorage projection and local child
navigation do not independently prove one native run through vibex-mcp/Broker,
temporary SQLite, and the production router. Those layers are covered
separately by Delegation, Conversations, UDS, named-pipe, and frontend
navigation tests; a packaged-platform journey remains the M2 release gate on a
supported CI runner.

## Accessibility

The empty and restored-projection states were scanned with axe-core 4.12.1
using `wcag2a,wcag2aa`:

- violations: `0`
- incomplete checks: `0`
- passing rule groups: `19`

The composer has a localized accessible textbox name. Mention selection is
keyboard-operable, structured chips delete atomically with Backspace, card
states include text and icons rather than color alone, and the running spinner
respects reduced motion.

## Passing verification

- Target Agent E Vitest: 5 files, 51 tests passed.
- Full frontend Vitest: 194 files, 977 tests passed.
- `cargo test -p delegation-proto`: 4 passed.
- `cargo test -p delegation`: 65 passed.
- `cargo test -p vibex-mcp`: 12 passed.
- `cargo test -p conversations`: 51 passed.
- `pnpm run check`: passed.
- `pnpm run lint`: passed.
- `cargo fmt --all -- --check`: passed.

The full frontend suite still prints pre-existing React `act(...)` and React
Router future-flag warnings. These warnings were present in the Agent E
baseline; the suite exits successfully.
