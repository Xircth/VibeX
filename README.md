# VibeX

<p align="center">
  English · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <strong>IAP · Integrated Agent Platform</strong><br />
  A unified workspace for agents, tools, and collaboration in Vibe Coding.
</p>

<p align="center">
  <a href="https://github.com/Xircth/VibeX/releases/latest"><img src="https://img.shields.io/badge/Download-Latest_Release-2563EB?style=flat-square" alt="Download latest release" /></a>
  <img src="https://img.shields.io/badge/macOS-Intel_%7C_Apple_Silicon-111827?style=flat-square" alt="macOS support" />
  <img src="https://img.shields.io/badge/Windows-x64_%7C_ARM64-2563EB?style=flat-square" alt="Windows x64 and ARM64 support" />
  <img src="https://img.shields.io/badge/Linux-x64_%7C_ARM64-F59E0B?style=flat-square" alt="Linux x64 and ARM64 support" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-16A34A?style=flat-square" alt="Apache 2.0 License" /></a>
</p>

<p align="center">
  <a href="https://github.com/Xircth/VibeX/releases/latest">Download</a> ·
  <a href="https://github.com/Xircth/VibeX/issues">Report an issue</a> ·
  <a href="#local-development">Local development</a>
</p>

![VibeX IAP connects multiple agents to one orchestration core through ACP](./docs/readme/iap-hero.svg)

VibeX brings Claude Code, Codex, OpenCode, Pi, and ACP Registry agents into one desktop environment. Every agent uses a shared pipeline for detection, installation, authentication, configuration, updates, and conversations.

The project is built around three goals: connect more agents, isolate parallel work, and bring software delivery into one place. Developers can organize conversations, create worktrees, delegate subtasks, review code, and use the integrated browser, Git tools, terminals, and session board without leaving the application.

> [!IMPORTANT]
> **Local operation and privacy:** VibeX is a local-first agent host. VibeX does not provide cloud storage for your data and does not automatically upload projects, conversations, configuration, or diagnostics to a VibeX server.
>
> **Testing-stage notice:** VibeX is still in testing. Use version control, keep backups of important projects, and review agent-generated changes before committing, syncing, or merging them.
>
> Enabled agents, model providers, MCP servers, plugins, messaging channels, and browser sessions may connect to third-party services according to your configuration. Those services handle data under their own privacy policies.

## IAP Capabilities

### Multiple agents, one platform

- **Built-in agent profiles:** First-class support for Claude Code, Codex, OpenCode, and Pi.
- **ACP Registry:** Browse and add more compatible agents from the official ACP Registry.
- **Unified lifecycle:** Inspect runtime, ACP adapter, version, location, authentication, configuration, and diagnostics in one place.
- **Local runtime reuse:** Detect and validate compatible CLIs already installed on the machine.
- **Managed installation:** Install missing components at pinned versions, persist installation locks, and expose update, repair, and uninstall actions.
- **Managed foundation runtimes:** Agents that need npm use a Node.js runtime validated and managed by VibeX, without requiring a system Node/npm installation.
- **Separate authentication state:** Complete account login or API configuration in the corresponding agent after installation.

Agents join the shared conversation pipeline through the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/). Model, mode, and reasoning controls are shown according to the capabilities of each agent, while preserving agent-specific behavior.

### Worktrees and multi-agent collaboration

![VibeX multi-agent workflow from task to delivery](./docs/readme/collaboration-flow.svg)

- Create an isolated Git worktree for each task so parallel conversations have clear filesystem boundaries.
- Run multiple agent conversations in the same project for implementation, testing, review, and debugging.
- Use `&Agent` mentions to express delegation intent. When the parent agent has the required MCP capability, it can create asynchronous child conversations and collect their results.
- Track each subtask independently with its own conversation history, status, and cancellation controls.
- Fork, resume, cancel, retry, import, and export conversations while persistent events retain execution history.

## Vibe Coding Tools

| Component | What it provides |
| --- | --- |
| **Session board** | Organize conversations by project and state, and inspect parallel work, agent status, and resource usage. |
| **Integrated browser** | A dedicated Chromium/CEF runtime with tabs, navigation, device sizes, DevTools, element inspection, Console, and Network tools. |
| **Git panel** | Inspect changes, diffs, history, branches, stashes, issues, and pull requests; stage and commit changes. |
| **Files and diffs** | Browse the file tree, preview common formats, compare unified or side-by-side diffs, and add review comments. |
| **Integrated terminal** | Manage multiple terminal sessions and run development servers, tests, and project scripts. |
| **MCP, skills, and plugins** | Manage agent tools, reusable skills, and structured workflow actions. |
| **Automations** | Save agent, workspace, branch, and action settings; launch isolated scheduled work and retain run history. |
| **Messaging and remote devices** | Send conversation notifications to external channels and use authorized devices for supported remote workflows. |
| **Office artifact previews** | Preview `.docx`, `.xlsx`, and `.pptx` artifacts through the managed OfficeCLI capability. |

## Download and Installation

Download the installer for your platform from [GitHub Releases](https://github.com/Xircth/VibeX/releases/latest).

| Platform | Baseline | Architecture | Package | Installation |
| --- | --- | --- | --- | --- |
| macOS | macOS 12 or later | Intel / ARM64 | `.dmg` | Open the image and drag `VibeX.app` into Applications. |
| Windows | Windows 10/11 | x64 / ARM64 | `.exe` / `.msi` | Run the installer and follow the setup wizard. |
| Linux | Ubuntu 22.04 equivalent | x64 / ARM64 | `.AppImage` / `.deb` | Run the AppImage or install the deb with your package manager. |

Windows installers include the offline WebView2 installer, so first launch does not depend on a network download. VibeX and its background agent, Git, npm, and uv processes do not open visible console windows. The integrated Chromium/CEF child window on Linux requires X11 or XWayland. The `.deb` declares an `xwayland` dependency; pure Wayland systems using the AppImage must install and enable XWayland separately.

On first launch, VibeX checks local agent runtimes and the ACP Registry. Select the agents to enable, choose a default agent and external editor, and continue to the workspace. Missing managed components are installed in the background.

Compatible local runtimes are reused. Account login, browser authorization, and API configuration remain part of each agent's official authentication flow.

### If macOS blocks the application

The production release process requires Developer ID signing, notarization, and Gatekeeper verification; missing credentials prevent a release from being created. If macOS still blocks the app, confirm that the installer came from the [official VibeX Releases page](https://github.com/Xircth/VibeX/releases/latest), then review the reason under System Settings > Privacy & Security. Do not disable Gatekeeper globally or remove quarantine attributes from software obtained from an unknown source.

### Initial agent setup

1. Select the agents you want to enable during onboarding.
2. Choose the default agent used for new conversations.
3. Select an external editor.
4. Wait for background installation notifications and review preflight results under Settings > Agents.
5. Complete login or API configuration through the agent's official flow.

If a runtime or ACP adapter is unhealthy, Settings > Agents shows its version, location, diagnostics, and the available install or repair action.

## Local Development

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- [pnpm](https://pnpm.io/) 8 or later
- [Rust](https://rustup.rs/); `rust-toolchain.toml` selects the repository toolchain
- The [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/) for your platform
- At least one agent CLI for integration testing

### Start the desktop app

```bash
pnpm install
pnpm run dev
```

This starts the React/Vite frontend, Tauri desktop shell, and Rust services.

### Checks and tests

```bash
pnpm run check
pnpm run lint
cd frontend && pnpm test
cargo test --workspace
```

### Build installers

```bash
pnpm run tauri:build
```

Platform-specific commands are also available:

```bash
pnpm run tauri:build:macos
pnpm run tauri:build:windows
pnpm run tauri:build:linux
```

## Architecture

```text
frontend/        React + TypeScript + Vite user interface
src-tauri/       Tauri desktop shell, system integration, and IPC commands
crates/agents/   Agent profiles, ACP, installation, and conversation runtime
crates/git/      Git and worktree capabilities
crates/browser-* Chromium/CEF browser runtime
crates/          Conversations, automations, plugins, artifacts, and services
shared/          TypeScript types generated from Rust
```

VibeX is built with Tauri, Rust, and React. Application data managed by VibeX stays on the local machine and is not automatically uploaded to a VibeX server. Selected agents, model providers, MCP servers, plugins, messaging channels, and browser sessions may connect to external services under their respective data and account policies.

`shared/types.ts` is generated. Run `pnpm run generate-types` after changing shared Rust types.

## Contributing

Bug reports and feature requests are welcome through [Issues](https://github.com/Xircth/VibeX/issues), and pull requests are welcome. Run the checks and tests relevant to your changes before submitting code.

VibeX is licensed under the [Apache License 2.0](./LICENSE).

## Acknowledgements

VibeX is built on [Tauri](https://tauri.app/), [React](https://react.dev/), [Rust](https://www.rust-lang.org/), and the [Agent Client Protocol](https://agentclientprotocol.com/).
