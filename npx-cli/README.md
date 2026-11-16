# `dimoai` — Dimo Host & Control CLI

Official CLI and Host-family launcher for **Dimo** — the **Integrated Agent Development Environment (IADE)** unifying **20 built-in Coding Agents** (Claude Code, Codex, DeepSeek Harness, Google Antigravity, Cursor, OpenCode, Pi, Grok, Cline, OpenClaw, Hermes, CodeBuddy, Kimi Code, Qoder, Kiro CLI, Auggie, TRAE CLI, Command Code, ZCode, OMP) and the **Official ACP Registry** on a single local-first Rust Host.

- **Website**: [https://vibex.xforever.xin](https://vibex.xforever.xin)
- **Documentation**: [https://vibex.xforever.xin/docs](https://vibex.xforever.xin/docs)
- **Plugin Marketplace**: [https://vibex.xforever.xin/marketplace](https://vibex.xforever.xin/marketplace)
- **GitHub**: [https://github.com/DimoADE/Dimo](https://github.com/DimoADE/Dimo)

---

## What `dimoai` Does

`npx dimoai` downloads and verifies (SHA-256 sidecar + inner `SHA256SUMS`) the matching platform **Dimo Host family** release bundle (`dimo-server`, `dimo-mcp`, `dimo-workflow-mcp`, and the production `web/` workbench), then gives you four workflows from one binary:

1. **Launch `dimo-server` + WebUI** (`17891` default) on loopback or LAN—bringing the full Dual-Stage IDE + Infinite Spatial Canvas workbench to any browser or paired Desktop / iOS / Android client.
2. **Discover & install Coding Agents** (`list`, `install`) directly into the Host machine's user environment (`npm`, `uv`, or verified binaries).
3. **Drive a running Host headlessly** (`conversation`, `workflow`, `project`, `workspace`, `session`, `git`, `file`, `agent`) from scripts, CI, or external orchestrators.
4. **Develop, link, pack, install, and publish v4 Plugins** (`plugin ...`).

---

## 1. Start Dimo Host & WebUI

```bash
# Start Dimo Host on loopback (http://127.0.0.1:17891)
npx dimoai

# Start the WebUI on LAN (0.0.0.0:17891) and print the persistent Host token
npx dimoai serve
# Alias:
npx dimoai web

# Loopback-only WebUI, custom port, or token rotation
npx dimoai serve --local --port 17891
npx dimoai serve --rotate-token

# Start the stdio MCP companion binary (dimo-mcp)
npx dimoai --mcp
```

Or install globally:

```bash
npm install -g dimoai
dimo serve
```

### Host Environment Overrides

| Variable | Description |
| :--- | :--- |
| `DIMO_HOST_FAMILY_TAG` | Pin an exact GitHub Release tag (for example `v0.4.4`). |
| `DIMO_HOST_FAMILY_DIR` | Use a pre-extracted local Host-family directory instead of downloading. |
| `DIMO_DATA_DIR` | Override the Dimo SQLite / transcript / plugin state directory. |
| `DIMO_SERVER_LISTEN` | Bind address and port (default `127.0.0.1:17891`). |
| `DIMO_URL` / `DIMO_TOKEN` | Target Host URL and Bearer token for remote control subcommands. |

---

## 2. Manage Coding Agents on This Machine

Install Agent runtimes and ACP adapters into your user environment without starting the HTTP server:

```bash
# List all 20 built-in agents and cached ACP Registry entries
npx dimoai list

# Refresh from the upstream Official ACP Registry first
npx dimoai list --refresh --json

# Install an agent into user environment (npm global prefix, uv tools, or ~/.local/bin)
npx dimoai install claude_code --yes
npx dimoai install codex --yes
```

---

## 3. Headless Control Commands

Point `DIMO_URL` (default `http://127.0.0.1:17891`) and `DIMO_TOKEN` at a running Desktop or Server Host:

```bash
# Projects, Workspaces (Git Worktrees), and Sessions
dimo project list
dimo project create --name my-service --path /path/to/repo
dimo workspace list --project <project-id>
dimo session create --workspace <workspace-id> --agent claude_code --prompt "Audit auth middleware"

# Event-Sourced Conversations, Live Steering & Child Delegation
dimo conversation create --workspace <workspace-id> --agent codex --prompt "Write integration tests"
dimo conversation steer --conversation <conv-id> --turn <turn-id> --text "Focus on edge cases in token expiry"
dimo conversation child --parent <conv-id> --agent claude_code --prompt "Review SQL queries"
dimo conversation wait --conversation <conv-id> --timeout 300

# Durable DAG Workflows
dimo workflow validate --file ./release-check.dimo-workflow.json
dimo workflow publish --file ./release-check.dimo-workflow.json
dimo workflow run --version <version-id> --workspace <workspace-id>
dimo workflow wait --run <run-id>
dimo workflow resume --run <run-id> --decision accept --step <step-id>

# Remote File & Git Operations
dimo file tree --path src --depth 3
dimo git status --workspace <workspace-id> --repo <repo-id>
dimo git commit --workspace <workspace-id> --repo <repo-id> --message "feat: add session guard"
```

---

## 4. Plugin Management & Developer Workflow

Install `.vxp` archives, GitHub repositories, or live-linked development folders onto your local Desktop or Server Host:

```bash
# Install from GitHub / Marketplace URL, local .vxp archive, or linked dev directory
dimo plugin add --web https://github.com/DimoADE/Dimo-plugin-office#v1.0.0 --yes
dimo plugin add --profile ./dist/acme.search-1.0.0.vxp --yes
dimo plugin add --dev ./my-plugin

# Inspect, update, remove, and garbage-collect unreferenced Runtimes
dimo plugin list
dimo plugin update dimo.office --yes
dimo plugin remove acme.search --delete-data
dimo plugin gc-runtimes

# Authoring loop (bind Host once, run HMR dev, test on Host, pack .vxp, publish)
dimo plugin run server --http://127.0.0.1:17891 --token <token>
dimo plugin run dev ./my-plugin
dimo plugin run build ./my-plugin
dimo plugin test --host ./my-plugin
dimo plugin pack ./my-plugin
dimo plugin publish ./dist/my-plugin-0.1.0.vxp
```

---

## Supported Host-Family Platforms

Release tarballs (`Dimo-${VERSION}-${PLATFORM}-server.tar.gz` + `.sha256`) are published for:

- **macOS**: Apple Silicon (`darwin-aarch64`, automatic Rosetta detection)
- **Windows**: `windows-x86_64`, `windows-aarch64`
- **Linux**: `linux-x86_64`, `linux-aarch64`

Run `npx dimoai help` or `npx dimoai help <topic>` (`serve`, `list`, `install`, `plugin`, `conversation`, `workflow`, `project`, `workspace`, `session`, `file`, `git`, `agent`) for complete option details.
