# `@omnione/vibex` — VibeX Host & Control CLI

Official CLI and Host-family launcher for **VibeX** — the **Integrated Agent Development Environment (IADE)** unifying **20 built-in Coding Agents** (Claude Code, Codex, DeepSeek Harness, Google Antigravity, Cursor, OpenCode, Pi, Grok, Cline, OpenClaw, Hermes, CodeBuddy, Kimi Code, Qoder, Kiro CLI, Auggie, TRAE CLI, Command Code, ZCode, OMP) and the **Official ACP Registry** on a single local-first Rust Host.

- **Website**: [https://vibex.xforever.xin](https://vibex.xforever.xin)
- **Documentation**: [https://vibex.xforever.xin/docs](https://vibex.xforever.xin/docs)
- **Plugin Marketplace**: [https://vibex.xforever.xin/marketplace](https://vibex.xforever.xin/marketplace)
- **GitHub**: [https://github.com/Xircth/VibeX](https://github.com/Xircth/VibeX)

---

## What `@omnione/vibex` Does

`npx @omnione/vibex` downloads and verifies (SHA-256 sidecar + inner `SHA256SUMS`) the matching platform **VibeX Host family** release bundle (`vibex-server`, `vibex-mcp`, `vibex-workflow-mcp`, and the production `web/` workbench), then gives you four workflows from one binary:

1. **Launch `vibex-server` + WebUI** (`17891` default) on loopback or LAN—bringing the full Dual-Stage IDE + Infinite Spatial Canvas workbench to any browser or paired Desktop / iOS / Android client.
2. **Discover & install Coding Agents** (`list`, `install`) directly into the Host machine's user environment (`npm`, `uv`, or verified binaries).
3. **Drive a running Host headlessly** (`conversation`, `workflow`, `project`, `workspace`, `session`, `git`, `file`, `agent`) from scripts, CI, or external orchestrators.
4. **Develop, link, pack, install, and publish v4 Plugins** (`plugin ...`).

---

## 1. Start VibeX Host & WebUI

```bash
# Start VibeX Host on loopback (http://127.0.0.1:17891)
npx @omnione/vibex

# Start the WebUI on LAN (0.0.0.0:17891) and print the persistent Host token
npx @omnione/vibex serve
# Alias:
npx @omnione/vibex web

# Loopback-only WebUI, custom port, or token rotation
npx @omnione/vibex serve --local --port 17891
npx @omnione/vibex serve --rotate-token

# Start the stdio MCP companion binary (vibex-mcp)
npx @omnione/vibex --mcp
```

Or install globally:

```bash
npm install -g @omnione/vibex
vibex serve
```

### Host Environment Overrides

| Variable | Description |
| :--- | :--- |
| `VIBEX_HOST_FAMILY_TAG` | Pin an exact GitHub Release tag (for example `v0.4.4`). |
| `VIBEX_HOST_FAMILY_DIR` | Use a pre-extracted local Host-family directory instead of downloading. |
| `VIBEX_DATA_DIR` | Override the VibeX SQLite / transcript / plugin state directory. |
| `VIBEX_SERVER_LISTEN` | Bind address and port (default `127.0.0.1:17891`). |
| `VIBEX_URL` / `VIBEX_TOKEN` | Target Host URL and Bearer token for remote control subcommands. |

---

## 2. Manage Coding Agents on This Machine

Install Agent runtimes and ACP adapters into your user environment without starting the HTTP server:

```bash
# List all 20 built-in agents and cached ACP Registry entries
npx @omnione/vibex list

# Refresh from the upstream Official ACP Registry first
npx @omnione/vibex list --refresh --json

# Install an agent into user environment (npm global prefix, uv tools, or ~/.local/bin)
npx @omnione/vibex install claude_code --yes
npx @omnione/vibex install codex --yes
```

---

## 3. Headless Control Commands

Point `VIBEX_URL` (default `http://127.0.0.1:17891`) and `VIBEX_TOKEN` at a running Desktop or Server Host:

```bash
# Projects, Workspaces (Git Worktrees), and Sessions
vibex project list
vibex project create --name my-service --path /path/to/repo
vibex workspace list --project <project-id>
vibex session create --workspace <workspace-id> --agent claude_code --prompt "Audit auth middleware"

# Event-Sourced Conversations, Live Steering & Child Delegation
vibex conversation create --workspace <workspace-id> --agent codex --prompt "Write integration tests"
vibex conversation steer --conversation <conv-id> --turn <turn-id> --text "Focus on edge cases in token expiry"
vibex conversation child --parent <conv-id> --agent claude_code --prompt "Review SQL queries"
vibex conversation wait --conversation <conv-id> --timeout 300

# Durable DAG Workflows
vibex workflow validate --file ./release-check.vibex-workflow.json
vibex workflow publish --file ./release-check.vibex-workflow.json
vibex workflow run --version <version-id> --workspace <workspace-id>
vibex workflow wait --run <run-id>
vibex workflow resume --run <run-id> --decision accept --step <step-id>

# Remote File & Git Operations
vibex file tree --path src --depth 3
vibex git status --workspace <workspace-id> --repo <repo-id>
vibex git commit --workspace <workspace-id> --repo <repo-id> --message "feat: add session guard"
```

---

## 4. Plugin Management & Developer Workflow

Install `.vxp` archives, GitHub repositories, or live-linked development folders onto your local Desktop or Server Host:

```bash
# Install from GitHub / Marketplace URL, local .vxp archive, or linked dev directory
vibex plugin add --web https://github.com/Xircth/vibex-plugin-office#v1.0.0 --yes
vibex plugin add --profile ./dist/acme.search-1.0.0.vxp --yes
vibex plugin add --dev ./my-plugin

# Inspect, update, remove, and garbage-collect unreferenced Runtimes
vibex plugin list
vibex plugin update vibex.office --yes
vibex plugin remove acme.search --delete-data
vibex plugin gc-runtimes

# Authoring loop (bind Host once, run HMR dev, test on Host, pack .vxp, publish)
vibex plugin run server --http://127.0.0.1:17891 --token <token>
vibex plugin run dev ./my-plugin
vibex plugin run build ./my-plugin
vibex plugin test --host ./my-plugin
vibex plugin pack ./my-plugin
vibex plugin publish ./dist/my-plugin-0.1.0.vxp
```

---

## Supported Host-Family Platforms

Release tarballs (`VibeX-${VERSION}-${PLATFORM}-server.tar.gz` + `.sha256`) are published for:

- **macOS**: Apple Silicon (`darwin-aarch64`, automatic Rosetta detection)
- **Windows**: `windows-x86_64`, `windows-aarch64`
- **Linux**: `linux-x86_64`, `linux-aarch64`

Run `npx @omnione/vibex help` or `npx @omnione/vibex help <topic>` (`serve`, `list`, `install`, `plugin`, `conversation`, `workflow`, `project`, `workspace`, `session`, `file`, `git`, `agent`) for complete option details.
