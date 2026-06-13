# Settings Platform Services Requirements

## Assumptions

1. Work happens in `C:\Users\Administrator\Documents\Projects\VibeX-settings-platform-services` on branch `feature/settings-platform-services`, based on local `master`.
2. `C:\Users\Administrator\Documents\Projects\codeg-main` is the primary implementation reference for settings IA, backup/restore, network proxy, web service, chat channels, model providers, and version-control settings.
3. `farion1231/cc-switch` is the behavioral reference for model-provider management: multi-agent provider presets, one-click switching, provider endpoint/API-key editing, OpenAI-compatible model fetching, and preserving custom provider configuration.
4. VibeX remains a Tauri desktop app first. Web-service settings should expose a local service and credentials, but the implementation must fit VibeX's existing React Router + Tauri command architecture.
5. Existing `#tag` prompt insertion must keep working while the setting is renamed and expanded into "指令".
6. Secrets such as API keys, IM bot tokens, and GitHub tokens must not be written into plain config unless the existing platform has no secure store available; if a secure store is unavailable, store only non-secret metadata and keep secrets behind dedicated commands.

## Objective

Converge VibeX settings into a broader platform settings surface, matching the Tahoe design system while adding the user-requested settings capabilities:

- System backup and restore.
- System network proxy.
- Web service.
- Message channels for IM robots, event notifications, and coding activity queries.
- Model provider management inspired by CC Switch.
- System rendering acceleration.
- Independent "指令" settings replacing "系统 / 标签提示词".
- Move terminal and preview settings from "编辑" to "常规".
- Move Git and PR settings from "编辑" to "版本管理", then add Git version settings and GitHub accounts.

Success means the settings navigation, pages, APIs, and storage surfaces are coherent, discoverable, and consistent with `DESIGN.md`.

## Functional Requirements

### R1. Settings Navigation

- Replace the current flat settings nav with the target IA:
  - `Agent`
  - `外观`
  - `常规`
  - `模型供应商`
  - `MCP`
  - `技能`
  - `指令`
  - `交互`
  - `版本管理`
  - `消息渠道`
  - `Web 服务`
  - `系统`
- Remove the old `编辑` nav item after its sections are redistributed.
- Existing settings routes must redirect to the nearest new route:
  - `/settings/editor` -> `/settings/general`
  - legacy tag/system prompt entry -> `/settings/instructions`

### R2. System Backup And Restore

- Add a "备份与恢复" section under `设置 / 系统`.
- Export a portable VibeX backup file, default extension `.vibexbak`.
- Backup should include:
  - app config,
  - executor profiles,
  - SQLite application data,
  - locally hosted skills/MCP registries under VibeX-managed directories,
  - metadata manifest with app name, app version, schema/migration marker, created time, and format version.
- Backup should exclude transient caches and running process state.
- Optional passphrase encryption should be supported if the imported code path includes it.
- Restore must inspect the backup first and show compatibility metadata before applying.
- Restore should be staged and applied safely, requiring restart/reload when needed.

### R3. System Network Proxy

- Add network proxy controls under `设置 / 系统`.
- User can enable/disable proxy and set proxy URL.
- Proxy URL must be validated before saving when enabled.
- Saved proxy should be used by backend HTTP clients where VibeX owns the client.
- Spawned agent processes should receive proxy environment variables when enabled, where doing so is compatible with existing process launch paths.

### R4. Web Service

- Add independent `设置 / Web 服务` page.
- User can configure port, access token, and auto-start.
- User can start/stop the local web service from the page.
- Page shows status, reachable local/LAN addresses, copy/open actions, and a QR affordance if dependencies are available.
- Port conflicts should be detected and explained.
- Token must be generated when absent and masked in the UI.

### R5. Message Channels

- Add independent `设置 / 消息渠道` page.
- User can configure IM bot channels, initially aligned with the `codeg-main` channel model:
  - Telegram,
  - Lark/Feishu,
  - Weixin/WeChat if portable enough,
  - generic webhook where supported.
- Page must support channel CRUD, enable/disable, test/send, connection status, command prefix, event filters, webhook URLs, and message language.
- Channels receive coding activity events and can query coding activity.
- Event notifications should be configurable so noisy events can be disabled.

### R6. Model Providers

- Add independent `设置 / 模型供应商` page.
- User can list, filter, create, edit, delete, and switch model providers per supported Agent.
- Provider fields should include:
  - name,
  - target Agent(s),
  - base URL,
  - API key / token,
  - auth format / compatibility mode,
  - default model(s),
  - optional custom JSON config.
- Follow CC Switch behavior where practical:
  - one-click provider switching for multiple CLI agents,
  - provider presets,
  - OpenAI-compatible `/v1/models` fetch,
  - custom provider JSON for edge cases,
  - preserve shared/custom provider fields when switching.
- Provider secrets must be masked in UI and stored via secure storage or equivalent secret commands.

### R7. Rendering Acceleration

- Add "渲染加速" controls under `设置 / 系统`.
- Support at least:
  - automatic/default,
  - force GPU acceleration,
  - disable GPU acceleration / software rendering.
- UI must explain that changes apply on restart if the runtime cannot switch immediately.
- Windows compatibility must be first-class because WebView2 GPU flags differ from macOS/Linux.

### R8. Instructions

- Replace `设置 / 系统 / 标签提示词` with independent `设置 / 指令`.
- Page layout mirrors `MCP` two-pane structure:
  - left pane: list,
  - right pane: preview/edit detail.
- Left pane has tabs:
  - `本地`: configured shortcut instructions,
  - `官方市场`: built-in official instructions that can be installed locally.
- Local tab:
  - supports search,
  - list of instructions,
  - bottom/new action for creating an instruction,
  - create fields: name, available Agents, content.
  - available Agents defaults to all; user can customize via multi-select.
- Official market tab:
  - list built-in instructions,
  - clicking an item previews it,
  - user can install/configure it into local instructions.
- Selecting a local instruction previews and edits its configuration.
- Existing `#tag_name` insertion should continue to resolve renamed instructions.

### R9. General Settings

- Create `设置 / 常规`.
- Move terminal settings from `设置 / 编辑 / 终端` to `设置 / 常规 / 终端`.
- Move preview settings from `设置 / 编辑 / 预览` to `设置 / 常规 / 预览`.
- Preserve external editor settings either under `常规 / 编辑器` or a compact subsection in `常规`.

### R10. Version Control Settings

- Create `设置 / 版本管理`.
- Move old `设置 / 编辑 / Git` content into:
  - `工作树设置`: workspace directory, branch prefix.
  - `Git 版本设置`: detected Git path/version and optional custom path.
- Move `PR 描述` into:
  - `PR 设置`: auto PR description and custom prompt.
- Add GitHub account management:
  - add account/token,
  - validate token,
  - set default,
  - remove account/token.

## Design Requirements

- `DESIGN.md` remains the design source of truth.
- Settings chrome uses `settings-titlebar`, `settings-sidebar`, and `settings-nav-button`.
- Content pages use opaque grouped surfaces: `settings-surface`, `settings-card`, `settings-row`, inset hairlines.
- No content glass. Glass is reserved for titlebar/sidebar/popover chrome.
- Controls remain compact: 32px inputs/buttons where practical, 6px control radius, 10px grouped cards, 14px outer panels.
- Use lucide icons for nav and actions.
- Primary blue appears only for selected/focused/primary/live state.
- All icon-only buttons must have `aria-label` or `title`.
- Text must not overflow controls at normal Windows desktop widths.

## Non-Goals

- Do not migrate VibeX to Next.js or codeg-main's app router.
- Do not replace VibeX's ACP-native agent settings model.
- Do not copy codeg-main UI verbatim if it violates VibeX Tahoe design tokens.
- Do not store raw secrets inside plain JSON config when an alternative is available.

## References

- Local reference: `C:\Users\Administrator\Documents\Projects\codeg-main`
- CC Switch repository: https://github.com/farion1231/cc-switch
- CC Switch provider docs: https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/2-providers/2.1-add.md
