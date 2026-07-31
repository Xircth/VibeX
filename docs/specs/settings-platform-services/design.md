# Settings Platform Services Design

## Architecture

This change is implemented as a settings-platform expansion inside the existing VibeX Tauri app:

- Frontend: React Router settings pages in `frontend/src/pages/settings`.
- Frontend API: Tauri command wrappers in `frontend/src/lib/api`.
- Backend commands: Rust modules under `src-tauri/src/commands`.
- Shared types: generated/handwritten additions in `shared/types.ts` and Rust structs where needed.
- Persistence:
  - existing config fields stay in `Config`;
  - feature-specific settings should use new command modules and either SQLite tables, `app_metadata`-style key/value storage, or VibeX-managed JSON files depending on existing local patterns;
  - secrets use secure token commands when possible.

The implementation uses VibeX's current SQLx/db crate patterns.

## Information Architecture

Target settings navigation:

```text
设置
├─ Agent
├─ 外观
├─ 常规
│  ├─ 终端
│  ├─ 编辑器
│  └─ 预览
├─ MCP
├─ 技能
├─ 指令
│  ├─ 本地
│  └─ 官方市场
├─ 交互
├─ 版本管理
│  ├─ Git 版本设置
│  ├─ 工作树设置
│  ├─ PR 设置
│  └─ GitHub 账号
├─ 消息渠道
├─ Web 服务
└─ 系统
   ├─ 本地环境
   ├─ 网络代理
   ├─ 渲染加速
   ├─ 备份与恢复
   ├─ 通知
   └─ 清除本地数据
```

## Frontend Page Patterns

### Standard Settings Page

Use for `常规`, `版本管理`, `系统`, and `Web 服务`.

```text
Page header
Grouped section
  row label                         control
  row label                         control
Grouped section
  status card                       actions
Sticky save bar when dirty
```

Classes should follow the current Tahoe vocabulary:

- outer page: `mx-auto max-w-2xl px-4 py-6` or full-height page when split pane is needed.
- section: `settings-section space-y-3`
- content group: `settings-card overflow-hidden rounded-lg border`
- row: `settings-row flex items-center justify-between gap-4`

### Two-Pane Settings Page

Use for `指令`, `MCP`, and other large list/detail pages when needed.

```text
┌ left pane ───────────────┬ right pane ─────────────────────┐
│ tabs/search/actions      │ selected title + actions         │
│ list rows                │ preview/editor                   │
│ bottom create action     │ metadata + target controls       │
└──────────────────────────┴─────────────────────────────────┘
```

The left pane is a content surface, not a second sidebar:

- opaque card/surface,
- row selection uses the accent state,
- toolbar controls remain compact,
- no nested cards inside cards.

## Backend Modules

### `commands::backup`

Build the backup service around:

- manifest,
- archive,
- optional encryption,
- inspect before restore,
- staged restore,
- progress events.

Adapt inputs to VibeX:

- SQLite DB path from deployment state,
- config path from `utils::assets::config_path()`,
- profiles path from `utils::assets::profiles_path()`,
- VibeX-managed MCP/skills directories.

Expose commands:

- `backup_create(options) -> BackupManifest`
- `backup_inspect(path, passphrase) -> BackupPreview`
- `backup_restore_stage(payload) -> BackupRestoreResult`
- `backup_cancel(op_id)`

### `commands::system_settings`

Provide small settings commands not suited for the main `Config` blob:

- proxy settings,
- rendering settings,
- terminal shell discovery if current `Config` is insufficient.

Expose commands:

- `get_system_proxy_settings`
- `update_system_proxy_settings`
- `get_system_rendering_settings`
- `update_system_rendering_settings`

### `commands::web_service`

Provide local service management:

- read/update saved web-service config,
- start/stop/status,
- port probe,
- token generation.

Expose commands:

- `get_web_service_config`
- `update_web_service_config`
- `get_web_server_status`
- `start_web_server`
- `stop_web_server`
- `probe_web_service_port`

### `commands::chat_channel`

Keep the first chat-channel integration vertical:

- channel metadata CRUD,
- token store,
- status/test,
- command prefix,
- event filters,
- event forwarding from VibeX ACP/workspace events.

Expose commands:

- `list_chat_channels`
- `create_chat_channel`
- `update_chat_channel`
- `delete_chat_channel`
- `save_chat_channel_token`
- `get_chat_channel_has_token`
- `delete_chat_channel_token`
- `test_chat_channel`
- `get_chat_event_filter`
- `set_chat_event_filter`
- `get_chat_command_prefix`
- `set_chat_command_prefix`

### `commands::instructions`

Build on the existing tag model but rename the domain:

- local instructions map from existing tags,
- add `available_agents` metadata,
- official market is static/bundled first.

Expose commands:

- `list_instructions`
- `create_instruction`
- `update_instruction`
- `delete_instruction`
- `list_official_instructions`
- `install_official_instruction`

Compatibility:

- `tagsApi` can continue to call existing tag commands while the UI migrates.
- Composer typeahead should continue to insert by `#name`.

### `commands::version_control`

Implement version-control settings using VibeX error/style conventions:

- Git detection and custom path validation,
- GitHub account metadata,
- token validation,
- secure token store.

Expose commands:

- `detect_git`
- `test_git_path`
- `get_git_settings`
- `update_git_settings`
- `get_github_accounts`
- `update_github_accounts`
- `validate_github_token`
- `save_account_token`
- `get_account_token`
- `delete_account_token`

## Data Model Sketch

### Instructions

```ts
interface Instruction {
  id: string;
  name: string;
  content: string;
  available_agents: string[];
  source: 'local' | 'official';
  created_at: string;
  updated_at: string;
}
```

### Web Service

```ts
interface WebServiceConfig {
  port: number;
  token: string | null;
  auto_start: boolean;
}
```

### Proxy

```ts
interface SystemProxySettings {
  enabled: boolean;
  proxy_url: string | null;
}
```

### Rendering

```ts
type RenderingAccelerationMode = 'auto' | 'force_gpu' | 'disable_gpu';
```

## Migration Strategy

1. Add routes/pages while preserving redirects from old paths.
2. Move UI sections without changing storage first.
3. Introduce new backend commands in vertical slices.
4. Switch UI from temporary static states to live commands per feature.
5. Keep old tag commands available until composer and any external callers use instruction naming.

## Design Constraints

- Use Tahoe grouped settings surfaces and compact controls.
- Keep long forms scannable: labels left, controls right, details in muted helper text.
- Use two-pane layout only when selection/detail is the primary task.
- Prefer existing shadcn/Radix components and lucide icons.
- Do not create marketing/hero-style settings screens.

## Risks

- Backup/restore can affect user data; restore must inspect first and stage safely.
- Message channels and web service touch network/listening surfaces; token handling must be careful.
- Rendering acceleration may require app restart and platform-specific behavior.
