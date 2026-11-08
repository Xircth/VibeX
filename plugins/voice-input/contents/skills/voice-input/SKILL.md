---
name: voice-input
description: Configure and use AI voice dictation, Whisper/Groq speech-to-text, custom vocabulary hotwords, and intelligent post-transcription cleanup in VibeX.
---

# AI Voice Input (`vibex.voice-input`)

This plugin adds AI voice dictation to VibeX's session composer, Monaco code editors, and status bar.

## Key Capabilities

1. **Multi-Engine Speech-to-Text (`providerProtocol`)**:
   - `hybrid`: Streams live interim captions via Web Speech API while recording and finalizes via cloud Whisper/Audio API (or falls back to live transcript + deterministic cleanup when offline/unconfigured).
   - `openai-whisper`: Standard OpenAI `/v1/audio/transcriptions` multipart upload (`whisper-1`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe`).
   - `groq-whisper`: Ultra-low-latency Groq `/openai/v1/audio/transcriptions` (`whisper-large-v3-turbo`, `whisper-large-v3`).
   - `openai-chat-audio`: OpenAI-compatible `/v1/chat/completions` multimodal `input_audio` single-pass transcription + cleanup.
   - `browser-speech`: Native zero-config Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`).

2. **Quality Controls & Post-Processing**:
   - **Language Hint (`language`)**: `auto`, `zh`, `en`, `ja`, `ko`.
   - **Custom Vocabulary / Hotwords (`vocabulary`)**: Biases Whisper decoding via `prompt` and normalizes phonetic/casing variations of project terms (`VibeX`, `Tauri`, `Monaco`, `Worktree`, etc.).
   - **Post-Transcription Cleanup (`cleanupMode`)**:
     - `auto-clean`: Removes spoken filler words (`嗯`, `啊`, `那个`, `um`, `uh`), normalizes CJK/ASCII spacing and punctuation, and optionally polishes via LLM while keeping the raw transcript accessible.
     - `preview`: Displays a side-by-side comparison of cleaned vs. raw transcript before inserting.
     - `off`: Inserts raw transcription without cleanup.
