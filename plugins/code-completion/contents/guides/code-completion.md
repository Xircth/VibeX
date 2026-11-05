# AI Code Completion Guide

`vibex.code-completion` provides inline Ghost Text suggestions in Monaco code editors across VibeX.

## Supported Protocols

1. **OpenAI Compatible (`openai-compatible`)**
   - Endpoint: `POST {baseUrl}/v1/chat/completions`
   - Works with OpenAI, DeepSeek, Qwen, SiliconFlow, OpenRouter, Ollama, and vLLM.
2. **Anthropic Compatible (`anthropic-compatible`)**
   - Endpoint: `POST {baseUrl}/v1/messages`
   - Uses Assistant Message Prefill (`<COMPLETION>`) and `stop_sequences: ["</COMPLETION>"]` so Claude models output raw code continuation directly from the cursor position.
3. **OpenAI Native FIM (`openai-fim`)**
   - Endpoint: `POST {baseUrl}/v1/completions` with `prompt` (prefix) and `suffix`.

## Keyboard Shortcuts

- `Tab`: Accept full inline Ghost Text suggestion (wrapped in an atomic Undo Stop barrier so a single `Ctrl+Z` / `Cmd+Z` reverts the entire completion).
- `Ctrl+Right` / `Cmd+Right`: Accept the next word of the inline suggestion.
- `Alt+\`: Manually trigger inline code completion at the current cursor.
- `Esc`: Dismiss current inline suggestion.
