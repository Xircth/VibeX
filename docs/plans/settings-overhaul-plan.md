# 设置页面大规模改造计划

> 参考: `./code-referance/codeg` 设置系统
> 范围: 5 个 Tab (Agents, MCP, Skills, Shortcuts, System) + 独立窗口
> 策略: 完整移植 UI + 所有后端功能

---

## 架构差异和适配策略

| 维度 | codeg | VibeUltra | 适配方案 |
|------|-------|-----------|----------|
| 前端框架 | Next.js 16 (App Router) | Vite + React 18 | 路由改用 react-router-dom |
| 状态管理 | React useState + Tauri IPC | Zustand + TanStack Query | 沿用 VibeUltra 现有模式 |
| 数据库 ORM | sea-orm | sqlx | 新增 migration + 表结构 |
| UI 组件库 | shadcn/ui | shadcn/ui | 直接复用，高度兼容 |
| i18n | next-intl | 无 | 暂不移植 i18n，使用中文硬编码 |
| 窗口 | 路由页面 | **独立 Tauri 窗口** | 新增 settings 窗口 |
| Agent 数据存储 | SQLite agent_setting 表 | profiles.json 文件 | **新增 agent_setting 表，同时保留 profiles.json 兼容** |

---

## Phase 0: 独立窗口基础设施 [预估 2-3 小时]

### 目标
创建独立的设置窗口，从主窗口通过 Toolbar 按钮或快捷键 `Ctrl+,` 打开。

### 任务

#### 0.1 Tauri 后端 - 窗口创建命令
- **文件**: `src-tauri/src/commands/settings_window.rs` (新建)
- **内容**:
  ```rust
  #[tauri::command]
  pub async fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
      // 如果 settings 窗口已存在，聚焦它
      // 否则创建新窗口，URL 指向 /settings
      // 窗口配置: 900x650, 居中, 可调整大小, 无最小化
  }
  ```
- **注册**: 在 `src-tauri/src/lib.rs` 的 `generate_handler!` 中添加

#### 0.2 前端 - 设置窗口入口路由
- **文件**: `frontend/src/App.tsx`
- **修改**: 保留 `/settings/*` 路由（用于独立窗口渲染），但移除主窗口中的导航链接
- **新建**: `frontend/src/pages/settings/SettingsWindow.tsx` - 独立窗口的根组件（带窗口标题栏）

#### 0.3 前端 - Toolbar 打开按钮
- **文件**: `frontend/src/components/layout/Toolbar.tsx`
- **修改**: 添加设置按钮，点击调用 `api.openSettingsWindow()`

#### 0.4 前端 API 封装
- **文件**: `frontend/src/lib/api.ts`
- **新增**: `openSettingsWindow()` 函数

---

## Phase 1: 设置外壳 (Settings Shell) [预估 1-2 小时]

### 目标
创建 codeg 风格的设置布局：左侧导航 + 右侧内容区。

### 任务

#### 1.1 重写 SettingsLayout
- **文件**: `frontend/src/pages/settings/SettingsLayout.tsx` (重写)
- **参考**: `code-referance/codeg/src/components/settings/settings-shell.tsx`
- **结构**:
  ```
  div.h-screen.bg-background
  ├── TitleBar (窗口标题栏 + 拖拽区域)
  └── div.flex.flex-1
      ├── aside.w-56 (左侧导航)
      │   ├── "偏好设置" 标题
      │   └── nav (5 个导航项)
      │       ├── 代理 (Bot icon)
      │       ├── MCP (PlugZap icon)
      │       ├── 技能 (BookOpenText icon)
      │       ├── 快捷键 (Keyboard icon)
      │       └── 系统 (Settings icon)
      └── section.flex-1.overflow-y-auto
          └── <Outlet />
  ```

#### 1.2 更新路由配置
- **文件**: `frontend/src/App.tsx`
- **修改**: 更新子路由
  ```
  /settings → 重定向到 /settings/agents
  /settings/agents → AgentSettings (新)
  /settings/mcp → McpSettings (重写)
  /settings/skills → SkillsSettings (新建)
  /settings/shortcuts → ShortcutSettings (新建)
  /settings/system → SystemSettings (重写自 GeneralSettings)
  ```
- **移除**: `/settings/projects`, `/settings/repos` 路由（功能合并到 System）

---

## Phase 2: Agent 设置页面 [预估 8-12 小时] - 最复杂

### 目标
完整移植 codeg 的 Agent 设置，包含拖拽排序、Preflight 检查、二进制管理。

### 2.1 后端 - 数据库层

#### 2.1.1 新增 agent_setting 表
- **文件**: `crates/db/migrations/` 新增 migration
- **表结构**:
  ```sql
  CREATE TABLE agent_setting (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_type TEXT NOT NULL UNIQUE,  -- 'claude_code', 'codex', 'open_code'
    enabled BOOLEAN NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    installed_version TEXT,
    env_json TEXT,                     -- JSON: {"KEY": "VALUE", ...}
    config_json TEXT,                  -- Agent 特定 JSON 配置
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ```

#### 2.1.2 CRUD 服务
- **文件**: `crates/db/src/agent_setting.rs` (新建)
- **方法**: `list_all()`, `get_by_type()`, `upsert()`, `update_sort_order()`

### 2.2 后端 - Tauri 命令

#### 2.2.1 Agent 管理命令
- **文件**: `src-tauri/src/commands/agent_settings.rs` (新建)
- **命令**:
  | 命令 | 说明 |
  |------|------|
  | `list_agents` | 列出所有 Agent 及其配置/状态 |
  | `update_agent_preferences` | 更新 Agent 的 enabled/env/config |
  | `reorder_agents` | 更新 Agent 排序 |
  | `agent_preflight` | 运行 Preflight 检查 |
  | `download_agent_binary` | 下载 Agent 二进制 |
  | `detect_agent_local_version` | 检测本地安装版本 |
  | `uninstall_agent` | 卸载 Agent |
  | `clear_agent_binary_cache` | 清理缓存 |

#### 2.2.2 Preflight 检查实现
- **文件**: `crates/services/src/services/agent_preflight.rs` (新建)
- **逻辑**:
  - Claude Code: 检查 `claude` CLI 是否在 PATH、版本号
  - Codex: 检查 `codex` CLI 或 npm/npx 可用性
  - OpenCode: 检查 `opencode` CLI 或 go install 可用性
- **返回**: `PreflightResult { checks: Vec<PreflightCheck> }`
  ```rust
  struct PreflightCheck {
      check_id: String,
      label: String,
      status: PreflightStatus, // Pass, Warn, Fail
      message: String,
      fixes: Vec<PreflightFix>,
  }
  ```

#### 2.2.3 二进制下载/安装实现
- **文件**: `crates/services/src/services/agent_binary.rs` (新建)
- **逻辑**:
  - 检测 OS/架构
  - 从 GitHub Releases / npm registry 下载
  - 解压到 `~/.vibe-ultra/bin/`
  - 更新 PATH（可选）

### 2.3 前端 - Agent 设置组件

#### 2.3.1 主页面组件
- **文件**: `frontend/src/pages/settings/AgentSettings.tsx` (重写)
- **参考**: `code-referance/codeg/src/components/settings/acp-agent-settings.tsx`
- **结构**:
  ```
  div.space-y-6
  ├── Header: "代理设置" + 描述
  └── Reorder.Group (Framer Motion 拖拽排序)
      ├── AgentCard[claude_code]
      ├── AgentCard[codex]
      └── AgentCard[open_code]
  ```

#### 2.3.2 AgentCard 组件
- **文件**: `frontend/src/components/settings/AgentCard.tsx` (新建)
- **结构**:
  ```
  Reorder.Item
  └── Card
      ├── CardHeader
      │   ├── 拖拽手柄 (GripVertical)
      │   ├── Agent 图标 + 名称
      │   ├── 版本 Badge
      │   └── Enable/Disable Switch
      ├── Preflight 检查区域 (可折叠)
      │   ├── CheckCircle / XCircle / AlertTriangle 图标
      │   ├── 检查消息
      │   └── 修复按钮
      ├── 配置区域 (Collapsible)
      │   ├── Agent 特定表单
      │   ├── 环境变量编辑器
      │   └── JSON 配置编辑器
      └── 操作按钮
          ├── Check (运行 Preflight)
          ├── Download / Update
          ├── Uninstall
          └── Save
  ```

#### 2.3.3 Agent 特定表单 (重写)
- **文件**: `frontend/src/components/settings/agents/ClaudeCodeForm.tsx` (重写)
  - API Base URL, API Key, Models Grid (Main, Reasoning, Haiku, Sonnet, Opus)
- **文件**: `frontend/src/components/settings/agents/CodexForm.tsx` (重写)
  - Provider, Model, API Base URL, API Key, Reasoning Effort, WebSocket, TOML, Auth JSON
- **文件**: `frontend/src/components/settings/agents/OpenCodeForm.tsx` (重写)
  - Model, Small Model, JSON Config, Auth JSON

#### 2.3.4 新增依赖
- `framer-motion` (拖拽排序)

### 2.4 前端 API

- **文件**: `frontend/src/lib/api.ts`
- **新增**:
  ```typescript
  listAgents(): Promise<AgentInfo[]>
  updateAgentPreferences(params): Promise<void>
  reorderAgents(agentTypes: string[]): Promise<void>
  agentPreflight(agentType: string): Promise<PreflightResult>
  downloadAgentBinary(agentType: string): Promise<void>
  detectAgentLocalVersion(agentType: string): Promise<string | null>
  uninstallAgent(agentType: string): Promise<void>
  clearAgentBinaryCache(agentType: string): Promise<void>
  ```

---

## Phase 3: MCP 设置页面 [预估 4-6 小时]

### 目标
移植 codeg 的 MCP 设置，包含本地扫描和 Marketplace 功能。

### 3.1 后端 - MCP 命令增强

#### 3.1.1 MCP 扫描和管理
- **文件**: `src-tauri/src/commands/mcp_settings.rs` (新建或扩展现有)
- **新增命令**:
  | 命令 | 说明 |
  |------|------|
  | `mcp_scan_local` | 扫描本地已安装的 MCP 服务器 |
  | `mcp_upsert_local_server` | 新增/更新本地 MCP 配置 |
  | `mcp_remove_server` | 删除 MCP 服务器 |
  | `mcp_list_marketplaces` | 列出可用 Marketplace |
  | `mcp_search_marketplace` | 搜索 Marketplace |
  | `mcp_get_marketplace_detail` | 获取 Marketplace 服务器详情 |
  | `mcp_install_from_marketplace` | 从 Marketplace 安装 |

### 3.2 前端 - MCP 设置组件

#### 3.2.1 主页面 (重写)
- **文件**: `frontend/src/pages/settings/McpSettings.tsx` (重写)
- **参考**: `code-referance/codeg/src/components/settings/mcp-settings.tsx`
- **结构**:
  ```
  div.flex.h-full
  ├── Left Panel (w-80)
  │   ├── Tabs: Local | Marketplace
  │   ├── Local Tab:
  │   │   ├── 搜索框
  │   │   └── Server 列表 (名称 + 协议 badge)
  │   └── Marketplace Tab:
  │       ├── Marketplace 选择器
  │       ├── 搜索框
  │       └── Server 列表
  └── Right Panel (flex-1)
      ├── Server 详情卡
      │   ├── 名称 + 版本 + 描述
      │   ├── Tools 列表
      │   ├── Resources 列表
      │   └── Prompts 列表
      └── 安装向导
          ├── 协议选择 (stdio/sse/http)
          ├── 动态参数表单
          └── 安装按钮
  ```

---

## Phase 4: Skills 设置页面 [预估 3-4 小时]

### 目标
移植 codeg 的 Skills 编辑器。

### 4.1 后端 - Skills 命令

#### 4.1.1 Skills 读写
- **文件**: `src-tauri/src/commands/skills.rs` (新建)
- **命令**:
  | 命令 | 说明 |
  |------|------|
  | `list_agent_skills` | 列出某 Agent 的所有 Skills |
  | `read_agent_skill` | 读取 Skill 内容 |
  | `save_agent_skill` | 保存 Skill |
  | `delete_agent_skill` | 删除 Skill |
  | `create_agent_skill` | 创建新 Skill |

#### 4.1.2 Skills 服务层
- **文件**: `crates/services/src/services/skills.rs` (新建)
- **逻辑**:
  - Claude Code Skills: 读写 `~/.claude/commands/` 目录
  - Codex Skills: 读写 `~/.codex/skills/` 或类似目录
  - OpenCode Skills: 读写对应目录

### 4.2 前端 - Skills 组件

#### 4.2.1 主页面
- **文件**: `frontend/src/pages/settings/SkillsSettings.tsx` (新建)
- **参考**: `code-referance/codeg/src/components/settings/skills-settings.tsx`
- **结构**:
  ```
  div.flex.h-full
  ├── Left Panel
  │   ├── Agent 选择器
  │   ├── 搜索框
  │   ├── Skill 列表
  │   └── + 新建按钮
  └── Right Panel (分割面板)
      ├── 编辑区 (Markdown + Front Matter)
      └── 预览区 (Markdown 渲染)
  ```

---

## Phase 5: Shortcuts 设置页面 [预估 2-3 小时]

### 目标
移植 codeg 的快捷键设置，支持录制和冲突检测。

### 5.1 前端 - 快捷键组件

#### 5.1.1 主页面
- **文件**: `frontend/src/pages/settings/ShortcutSettings.tsx` (新建)
- **参考**: `code-referance/codeg/src/components/settings/shortcut-settings.tsx`
- **结构**:
  ```
  div.space-y-4
  ├── Header: "快捷键" + "恢复默认" 按钮
  └── 快捷键列表
      ├── 每行: 操作名称 | 快捷键按钮 (可点击录制)
      └── 录制模式: 捕获 keydown → 验证 → 保存
  ```

#### 5.1.2 快捷键工具库
- **文件**: `frontend/src/lib/keyboard-shortcuts.ts` (新建)
- **参考**: `code-referance/codeg/src/lib/keyboard-shortcuts.ts`
- **导出**:
  ```typescript
  SHORTCUT_DEFINITIONS: ShortcutDefinition[]
  normalizeShortcut(raw: string): string | null
  shortcutFromKeyboardEvent(event, allowNoModifier?): string | null
  formatShortcutLabel(shortcut: string, isMac: boolean): string
  readShortcutSettings(): ShortcutSettings
  writeShortcutSettings(settings: ShortcutSettings): void
  ```

#### 5.1.3 快捷键 Hook
- **文件**: `frontend/src/hooks/useShortcutSettings.ts` (新建)

#### 5.1.4 快捷键定义 (适配 VibeUltra)
```typescript
const SHORTCUT_DEFINITIONS = [
  { id: "toggle_search", defaultKey: "mod+k", label: "搜索" },
  { id: "toggle_sidebar", defaultKey: "mod+b", label: "切换侧栏" },
  { id: "toggle_terminal", defaultKey: "mod+j", label: "切换终端" },
  { id: "new_terminal_tab", defaultKey: "mod+t", label: "新建终端标签" },
  { id: "close_terminal_tab", defaultKey: "mod+w", label: "关闭终端标签" },
  { id: "open_settings", defaultKey: "mod+,", label: "打开设置" },
  { id: "send_message", defaultKey: "enter", label: "发送消息" },
  { id: "newline_in_message", defaultKey: "shift+enter", label: "消息换行" },
  // ... 可根据 VibeUltra 实际需求调整
]
```

### 5.2 存储
- `localStorage['vibe-ultra-shortcuts:v1']` - JSON 格式

---

## Phase 6: System 设置页面 [预估 2-3 小时]

### 目标
将现有 GeneralSettings 重构为 codeg 风格的 System 设置页面。

### 6.1 后端 - 系统设置命令

#### 6.1.1 代理设置 (可选，如需 HTTP 代理)
- **文件**: 扩展 `src-tauri/src/commands/config.rs`
- **新增**: `get_proxy_settings`, `update_proxy_settings`

### 6.2 前端 - System 组件

#### 6.2.1 主页面
- **文件**: `frontend/src/pages/settings/SystemSettings.tsx` (新建，替代 GeneralSettings)
- **参考**: `code-referance/codeg/src/components/settings/system-network-settings.tsx`
- **结构**:
  ```
  div.space-y-8
  ├── Section: 外观
  │   └── 主题选择 (System / Light / Dark)
  ├── Section: 交互
  │   ├── 发送消息快捷键
  │   └── 默认终端 Shell
  ├── Section: 编辑器
  │   ├── 编辑器类型选择
  │   └── 自定义命令
  ├── Section: Git
  │   ├── 分支名前缀
  │   ├── 工作区目录
  │   └── 提交提醒
  ├── Section: 通知
  │   ├── 声音开关 + 选择
  │   └── 推送通知
  ├── Section: 应用更新
  │   ├── 当前版本
  │   ├── 检查更新按钮
  │   └── 更新日志
  └── Section: 重置
      ├── 重置免责声明
      └── 重置入门流程
  ```

---

## Phase 7: 清理和集成 [预估 2-3 小时]

### 任务

#### 7.1 移除旧设置页面
- 删除: `frontend/src/pages/settings/ProjectSettings.tsx`
- 删除: `frontend/src/pages/settings/ReposSettings.tsx`
- 更新: `frontend/src/pages/settings/index.ts` 导出

#### 7.2 主窗口设置入口
- 移除主窗口中的 `/settings` 路由导航（Sidebar 等）
- 确保 `Ctrl+,` 快捷键全局生效
- Toolbar 中添加齿轮图标按钮

#### 7.3 窗口间通信
- 设置窗口保存配置后，主窗口需要刷新
- 使用 Tauri Events: `settings-updated` 事件
- 主窗口监听事件并 `reloadSystem()`

#### 7.4 类型更新
- 运行 `cargo run --bin generate-types` 更新 `shared/types.ts`
- 确保所有新类型正确导出

---

## 文件变更清单

### 新建文件 (~25 个)

**后端 (Rust)**:
1. `src-tauri/src/commands/settings_window.rs` - 窗口管理
2. `src-tauri/src/commands/agent_settings.rs` - Agent 设置命令
3. `src-tauri/src/commands/mcp_settings.rs` - MCP 设置命令 (扩展)
4. `src-tauri/src/commands/skills.rs` - Skills 命令
5. `crates/db/migrations/YYYYMMDD_agent_setting.sql` - 数据库迁移
6. `crates/db/src/agent_setting.rs` - Agent 设置 CRUD
7. `crates/services/src/services/agent_preflight.rs` - Preflight 检查
8. `crates/services/src/services/agent_binary.rs` - 二进制管理
9. `crates/services/src/services/skills.rs` - Skills 服务
10. `crates/api-types/src/agent_settings.rs` - Agent 设置类型

**前端 (TypeScript/React)**:
11. `frontend/src/pages/settings/SettingsWindow.tsx` - 窗口根组件
12. `frontend/src/pages/settings/SkillsSettings.tsx` - Skills 页面
13. `frontend/src/pages/settings/ShortcutSettings.tsx` - 快捷键页面
14. `frontend/src/pages/settings/SystemSettings.tsx` - 系统设置
15. `frontend/src/components/settings/AgentCard.tsx` - Agent 卡片
16. `frontend/src/components/settings/agents/ClaudeCodeForm.tsx` - Claude 表单 (重写)
17. `frontend/src/components/settings/agents/CodexForm.tsx` - Codex 表单 (重写)
18. `frontend/src/components/settings/agents/OpenCodeForm.tsx` - OpenCode 表单 (重写)
19. `frontend/src/components/settings/McpServerCard.tsx` - MCP 服务器卡片
20. `frontend/src/components/settings/SkillEditor.tsx` - Skill 编辑器
21. `frontend/src/lib/keyboard-shortcuts.ts` - 快捷键工具
22. `frontend/src/hooks/useShortcutSettings.ts` - 快捷键 Hook
23. `frontend/src/hooks/useAgentSettings.ts` - Agent 设置 Hook (新)

### 修改文件 (~15 个)

1. `src-tauri/src/lib.rs` - 注册新命令
2. `src-tauri/tauri.conf.json` - 窗口权限配置
3. `frontend/src/App.tsx` - 路由更新
4. `frontend/src/pages/settings/SettingsLayout.tsx` - 布局重写
5. `frontend/src/pages/settings/AgentSettings.tsx` - 完全重写
6. `frontend/src/pages/settings/McpSettings.tsx` - 完全重写
7. `frontend/src/pages/settings/index.ts` - 导出更新
8. `frontend/src/lib/api.ts` - 新增 API 封装
9. `frontend/src/lib/agentConfigUtils.ts` - 适配新数据结构
10. `frontend/src/components/layout/Toolbar.tsx` - 添加设置按钮
11. `frontend/src/components/ConfigProvider.tsx` - 适配新数据流
12. `crates/db/src/lib.rs` - 注册新模块
13. `crates/services/src/lib.rs` - 注册新服务
14. `crates/api-types/src/lib.rs` - 注册新类型
15. `frontend/package.json` - 添加 framer-motion 依赖

### 删除文件 (~2 个)

1. `frontend/src/pages/settings/ProjectSettings.tsx`
2. `frontend/src/pages/settings/ReposSettings.tsx`

---

## 实施顺序和依赖关系

```
Phase 0 (独立窗口) ──┐
                      ├──→ Phase 1 (Shell 布局) ──→ Phase 6 (System)
                      │                          ──→ Phase 5 (Shortcuts)
Phase 2.1 (DB 层)  ──┤
Phase 2.2 (命令层) ──┤──→ Phase 2.3 (Agent UI) ──→ Phase 3 (MCP)
                      │                          ──→ Phase 4 (Skills)
                      └──→ Phase 7 (清理集成)
```

**建议执行顺序**: 0 → 1 → 2 → 6 → 5 → 3 → 4 → 7

---

## 风险和注意事项

1. **profiles.json 兼容性**: 新增 agent_setting 表后，需确保与现有 profiles.json 数据双向同步
2. **二进制下载安全**: 需验证下载源的可信度，使用 SHA256 校验
3. **跨平台路径**: Windows/macOS/Linux 的配置文件路径不同，需使用 `dirs` crate
4. **窗口生命周期**: 独立窗口关闭时需正确清理资源
5. **Framer Motion 兼容**: 确认与现有动画库无冲突
6. **代码量大**: Agent 设置页面约 5000+ 行，建议拆分为多个子组件（AgentCard、Forms 等）
