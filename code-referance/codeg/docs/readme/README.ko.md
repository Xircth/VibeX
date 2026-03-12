# Codeg

[![Release](https://img.shields.io/github/v/release/xintaofei/codeg)](https://github.com/xintaofei/codeg/releases)
[![License](https://img.shields.io/github/license/xintaofei/codeg)](../../LICENSE)

<p>
  <a href="../../README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <a href="./README.zh-TW.md">繁體中文</a> |
  <a href="./README.ja.md">日本語</a> |
  <strong>한국어</strong> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.pt.md">Português</a> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg(Code Generation)는 멀티 Agent를 위한 엔터프라이즈급 코드 생성 워크스페이스입니다.
Claude Code, Codex CLI, OpenCode, Gemini CLI 등 로컬 AI 코딩 Agent를 하나의 데스크톱 앱으로 통합하여 세션 집계, 병렬 `git worktree` 개발, MCP/Skills 관리, Git/파일/터미널 통합 워크플로를 제공합니다.

## 메인 인터페이스

![Codeg Light](../images/main-light.png#gh-light-mode-only)
![Codeg Dark](../images/main-dark.png#gh-dark-mode-only)

## 세션 타일 표시

![Codeg Light](../images/main2-light.png#gh-light-mode-only)
![Codeg Dark](../images/main2-dark.png#gh-dark-mode-only)

> 현재 버전: `v0.1.x` (빠르게 개선 중)

## 핵심 기능

- 하나의 프로젝트에서 멀티 Agent 통합 사용
- 로컬 세션 집계 및 구조화 표시
- 내장 `git worktree` 병렬 개발
- MCP 관리(로컬 스캔 + 검색/설치)
- Skills 관리(전역/프로젝트)
- 파일 트리, Diff, Git, 커밋, 터미널 통합

## 지원 범위

### 1) 세션 수집(히스토리)

| Agent | 환경 변수 우선 경로 | macOS / Linux 기본 경로 | Windows 기본 경로 |
| --- | --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects` | `~/.claude/projects` | `%USERPROFILE%\\.claude\\projects` |
| Codex CLI | `$CODEX_HOME/sessions` | `~/.codex/sessions` | `%USERPROFILE%\\.codex\\sessions` |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` | `~/.local/share/opencode/opencode.db` | `%USERPROFILE%\\.local\\share\\opencode\\opencode.db` |
| Gemini CLI | `$GEMINI_CLI_HOME/.gemini` | `~/.gemini` | `%USERPROFILE%\\.gemini` |

## 빠른 시작

### 요구 사항

- Node.js `>=22`
- pnpm `>=10`
- Rust stable (2021 edition)
- Tauri 2 빌드 의존성

### 개발 명령

```bash
pnpm install
pnpm tauri dev
pnpm dev
pnpm build
pnpm tauri build
pnpm eslint .

# src-tauri/ 에서 실행
cargo check
cargo clippy
cargo build
```

## 라이선스

Apache-2.0. `LICENSE` 참고.
