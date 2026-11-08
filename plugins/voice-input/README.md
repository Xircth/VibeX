# 语音输入 (`vibex.voice-input`)

为 VibeX 会话输入框与代码编辑器提供低延迟、高准确率的 AI 语音输入与听写后智能润色体验。

## 核心特性

- **多引擎混合语音识别（Multi-Provider STT）**：
  - **混合流式模式（`hybrid`，默认）**：说话时通过原生 Web Speech API 实时渲染流式字幕，停止录音后自动结合云端 Whisper / 多模态音频模型与智能润色输出高准确率文本；未配置云端 API Key 时亦可开箱即用。
  - **OpenAI Whisper（`openai-whisper`）**：支持 `/v1/audio/transcriptions` 标准分段上传（`gpt-4o-mini-transcribe`、`gpt-4o-transcribe`、`whisper-1`）。
  - **Groq 极速 Whisper（`groq-whisper`）**：支持 `whisper-large-v3-turbo` 与 `whisper-large-v3` 亚秒级语音转写。
  - **多模态 Chat Audio（`openai-chat-audio`）**：支持 `/v1/chat/completions` `input_audio` 单次完成语音识别与口水词清理。
  - **浏览器原生听写（`browser-speech`）**：纯本地/系统级实时语音识别，零 API 成本。
- **质量控制与智能后处理**：
  - **自定义术语热词表（`vocabulary`）**：支持配置项目专有名词、技术栈术语与命令（如 `VibeX, Tauri, Monaco, TypeScript, Rust, MCP, Skill, Worktree`），自动注入 Whisper `prompt` 并在后处理阶段修正大小写与同音误写。
  - **听写后智能润色（`cleanupMode`）**：
    - `auto-clean`（默认）：自动剔除中英文口水词（“嗯”、“啊”、“那个”、“就是说”、“um”、“uh”）、重复结巴词，规范化中英文间距与标点，并在配置了 API Key 时使用轻量模型润色，同时保留原始识别文本随时可回退。
    - `preview`：停止录音后弹出「润色文本 vs 原始识别」对照卡片，确认或微调后再插入输入框。
    - `off`：直接插入原始语音识别结果。
- **全场景无缝接入**：
  - **会话输入框底栏麦克风按钮**：直接内嵌于会话输入框底部工具栏（`composer.toolbar`），支持一键录音、声波振幅动画与计时显示。
  - **两种触发手势（`recordingMode`）**：支持 `toggle`（单击开始/单击结束）与 `push-to-talk`（按住说话、松开即转写），默认全局快捷键 `Alt+V`。
  - **多目标智能写入**：优先写入当前激活的 Monaco 代码编辑器光标处（带原子撤销屏障）或当前聚焦的 VibeX 会话输入框（`conversation.draft.insert`），无活跃输入框时自动复制至剪贴板。
  - **状态栏语音工作台（`status.after-mcp`）**：点击底部状态栏图标即可打开语音工作台，支持实时麦克风测试、设备切换、热词管理与最近听写历史一键重插。
