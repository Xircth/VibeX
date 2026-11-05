---
summary: Low-latency AI ghost-text inline code completion supporting OpenAI-compatible and Anthropic Messages endpoints.
---

# Code Completion (`vibex.code-completion`)

Provides low-latency AI inline code completion (Ghost Text) inside VibeX Monaco code editors with dual-protocol LLM support and privacy-aware Fill-in-the-Middle (FIM) context assembly.

## Key Capabilities

- **Dual-Protocol Completion Engine**:
  - `openai-compatible`: Calls `POST {baseUrl}/v1/chat/completions` with FIM `<PREFIX>` / `<SUFFIX>` boundaries and low-temperature deterministic code generation.
  - `anthropic-compatible`: Calls `POST {baseUrl}/v1/messages` using Assistant Message Prefill (`<COMPLETION>`) and `stop_sequences: ["</COMPLETION>"]` to eliminate conversational preambles and Markdown fences.
  - `openai-fim`: Optional native FIM endpoint (`POST {baseUrl}/v1/completions`) with `prompt` + `suffix`.
- **Adaptive Debounce & Cancellation**:
  - 180ms adaptive debounce on normal typing and 60ms fast trigger after structural tokens (`.`, `(`, `{`, `:`, `=`, `/`, `Enter`).
  - Automatic `AbortSignal` propagation cancels stale in-flight HTTP requests immediately on keystroke or cursor movement.
- **Deterministic Post-Processing & Privacy Guard**:
  - Automatically strips Markdown code fences, deduplicates prefix/suffix overlap, and trims redundant closing brackets.
  - Rejects sensitive files matching `ignoredGlobs` (`.env*`, `*.pem`, `*.key`, `*secret*`, `*.min.js`) before any network request is made.
