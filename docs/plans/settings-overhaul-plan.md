# 璁剧疆椤甸潰澶ц妯℃敼閫犺鍒?

> 鍙傝€? `./code-referance/codeg` 璁剧疆绯荤粺
> 鑼冨洿: 5 涓?Tab (Agents, MCP, Skills, Shortcuts, System) + 鐙珛绐楀彛
> 绛栫暐: 瀹屾暣绉绘 UI + 鎵€鏈夊悗绔姛鑳?

---

## 鏋舵瀯宸紓鍜岄€傞厤绛栫暐

| 缁村害 | codeg | VibeX | 閫傞厤鏂规 |
|------|-------|-----------|----------|
| 鍓嶇妗嗘灦 | Next.js 16 (App Router) | Vite + React 18 | 璺敱鏀圭敤 react-router-dom |
| 鐘舵€佺鐞?| React useState + Tauri IPC | Zustand + TanStack Query | 娌跨敤 VibeX 鐜版湁妯″紡 |
| 鏁版嵁搴?ORM | sea-orm | sqlx | 鏂板 migration + 琛ㄧ粨鏋?|
| UI 缁勪欢搴?| shadcn/ui | shadcn/ui | 鐩存帴澶嶇敤锛岄珮搴﹀吋瀹?|
| i18n | next-intl | 鏃?| 鏆備笉绉绘 i18n锛屼娇鐢ㄤ腑鏂囩‖缂栫爜 |
| 绐楀彛 | 璺敱椤甸潰 | **鐙珛 Tauri 绐楀彛** | 鏂板 settings 绐楀彛 |
| Agent 鏁版嵁瀛樺偍 | SQLite agent_setting 琛?| profiles.json 鏂囦欢 | **鏂板 agent_setting 琛紝鍚屾椂淇濈暀 profiles.json 鍏煎** |

---

## Phase 0: 鐙珛绐楀彛鍩虹璁炬柦 [棰勪及 2-3 灏忔椂]

### 鐩爣
鍒涘缓鐙珛鐨勮缃獥鍙ｏ紝浠庝富绐楀彛閫氳繃 Toolbar 鎸夐挳鎴栧揩鎹烽敭 `Ctrl+,` 鎵撳紑銆?

### 浠诲姟

#### 0.1 Tauri 鍚庣 - 绐楀彛鍒涘缓鍛戒护
- **鏂囦欢**: `src-tauri/src/commands/settings_window.rs` (鏂板缓)
- **鍐呭**:
  ```rust
  #[tauri::command]
  pub async fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
      // 濡傛灉 settings 绐楀彛宸插瓨鍦紝鑱氱劍瀹?
      // 鍚﹀垯鍒涘缓鏂扮獥鍙ｏ紝URL 鎸囧悜 /settings
      // 绐楀彛閰嶇疆: 900x650, 灞呬腑, 鍙皟鏁村ぇ灏? 鏃犳渶灏忓寲
  }
  ```
- **娉ㄥ唽**: 鍦?`src-tauri/src/lib.rs` 鐨?`generate_handler!` 涓坊鍔?

#### 0.2 鍓嶇 - 璁剧疆绐楀彛鍏ュ彛璺敱
- **鏂囦欢**: `frontend/src/App.tsx`
- **淇敼**: 淇濈暀 `/settings/*` 璺敱锛堢敤浜庣嫭绔嬬獥鍙ｆ覆鏌擄級锛屼絾绉婚櫎涓荤獥鍙ｄ腑鐨勫鑸摼鎺?
- **鏂板缓**: `frontend/src/pages/settings/SettingsWindow.tsx` - 鐙珛绐楀彛鐨勬牴缁勪欢锛堝甫绐楀彛鏍囬鏍忥級

#### 0.3 鍓嶇 - Toolbar 鎵撳紑鎸夐挳
- **鏂囦欢**: `frontend/src/components/layout/Toolbar.tsx`
- **淇敼**: 娣诲姞璁剧疆鎸夐挳锛岀偣鍑昏皟鐢?`api.openSettingsWindow()`

#### 0.4 鍓嶇 API 灏佽
- **鏂囦欢**: `frontend/src/lib/api.ts`
- **鏂板**: `openSettingsWindow()` 鍑芥暟

---

## Phase 1: 璁剧疆澶栧３ (Settings Shell) [棰勪及 1-2 灏忔椂]

### 鐩爣
鍒涘缓 codeg 椋庢牸鐨勮缃竷灞€锛氬乏渚у鑸?+ 鍙充晶鍐呭鍖恒€?

### 浠诲姟

#### 1.1 閲嶅啓 SettingsLayout
- **鏂囦欢**: `frontend/src/pages/settings/SettingsLayout.tsx` (閲嶅啓)
- **鍙傝€?*: `code-referance/codeg/src/components/settings/settings-shell.tsx`
- **缁撴瀯**:
  ```
  div.h-screen.bg-background
  鈹溾攢鈹€ TitleBar (绐楀彛鏍囬鏍?+ 鎷栨嫿鍖哄煙)
  鈹斺攢鈹€ div.flex.flex-1
      鈹溾攢鈹€ aside.w-56 (宸︿晶瀵艰埅)
      鈹?  鈹溾攢鈹€ "鍋忓ソ璁剧疆" 鏍囬
      鈹?  鈹斺攢鈹€ nav (5 涓鑸」)
      鈹?      鈹溾攢鈹€ 浠ｇ悊 (Bot icon)
      鈹?      鈹溾攢鈹€ MCP (PlugZap icon)
      鈹?      鈹溾攢鈹€ 鎶€鑳?(BookOpenText icon)
      鈹?      鈹溾攢鈹€ 蹇嵎閿?(Keyboard icon)
      鈹?      鈹斺攢鈹€ 绯荤粺 (Settings icon)
      鈹斺攢鈹€ section.flex-1.overflow-y-auto
          鈹斺攢鈹€ <Outlet />
  ```

#### 1.2 鏇存柊璺敱閰嶇疆
- **鏂囦欢**: `frontend/src/App.tsx`
- **淇敼**: 鏇存柊瀛愯矾鐢?
  ```
  /settings 鈫?閲嶅畾鍚戝埌 /settings/agents
  /settings/agents 鈫?AgentSettings (鏂?
  /settings/mcp 鈫?McpSettings (閲嶅啓)
  /settings/skills 鈫?SkillsSettings (鏂板缓)
  /settings/shortcuts 鈫?ShortcutSettings (鏂板缓)
  /settings/system 鈫?SystemSettings (閲嶅啓鑷?GeneralSettings)
  ```
- **绉婚櫎**: `/settings/projects`, `/settings/repos` 璺敱锛堝姛鑳藉悎骞跺埌 System锛?

---

## Phase 2: Agent 璁剧疆椤甸潰 [棰勪及 8-12 灏忔椂] - 鏈€澶嶆潅

### 鐩爣
瀹屾暣绉绘 codeg 鐨?Agent 璁剧疆锛屽寘鍚嫋鎷芥帓搴忋€丳reflight 妫€鏌ャ€佷簩杩涘埗绠＄悊銆?

### 2.1 鍚庣 - 鏁版嵁搴撳眰

#### 2.1.1 鏂板 agent_setting 琛?
- **鏂囦欢**: `crates/db/migrations/` 鏂板 migration
- **琛ㄧ粨鏋?*:
  ```sql
  CREATE TABLE agent_setting (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_type TEXT NOT NULL UNIQUE,  -- 'claude_code', 'codex', 'open_code'
    enabled BOOLEAN NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    installed_version TEXT,
    env_json TEXT,                     -- JSON: {"KEY": "VALUE", ...}
    config_json TEXT,                  -- Agent 鐗瑰畾 JSON 閰嶇疆
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ```

#### 2.1.2 CRUD 鏈嶅姟
- **鏂囦欢**: `crates/db/src/agent_setting.rs` (鏂板缓)
- **鏂规硶**: `list_all()`, `get_by_type()`, `upsert()`, `update_sort_order()`

### 2.2 鍚庣 - Tauri 鍛戒护

#### 2.2.1 Agent 绠＄悊鍛戒护
- **鏂囦欢**: `src-tauri/src/commands/agent_settings.rs` (鏂板缓)
- **鍛戒护**:
  | 鍛戒护 | 璇存槑 |
  |------|------|
  | `list_agents` | 鍒楀嚭鎵€鏈?Agent 鍙婂叾閰嶇疆/鐘舵€?|
  | `update_agent_preferences` | 鏇存柊 Agent 鐨?enabled/env/config |
  | `reorder_agents` | 鏇存柊 Agent 鎺掑簭 |
  | `agent_preflight` | 杩愯 Preflight 妫€鏌?|
  | `download_agent_binary` | 涓嬭浇 Agent 浜岃繘鍒?|
  | `detect_agent_local_version` | 妫€娴嬫湰鍦板畨瑁呯増鏈?|
  | `uninstall_agent` | 鍗歌浇 Agent |
  | `clear_agent_binary_cache` | 娓呯悊缂撳瓨 |

#### 2.2.2 Preflight 妫€鏌ュ疄鐜?
- **鏂囦欢**: `crates/services/src/services/agent_preflight.rs` (鏂板缓)
- **閫昏緫**:
  - Claude Code: 妫€鏌?`claude` CLI 鏄惁鍦?PATH銆佺増鏈彿
  - Codex: 妫€鏌?`codex` CLI 鎴?npm/npx 鍙敤鎬?
  - OpenCode: 妫€鏌?`opencode` CLI 鎴?go install 鍙敤鎬?
- **杩斿洖**: `PreflightResult { checks: Vec<PreflightCheck> }`
  ```rust
  struct PreflightCheck {
      check_id: String,
      label: String,
      status: PreflightStatus, // Pass, Warn, Fail
      message: String,
      fixes: Vec<PreflightFix>,
  }
  ```

#### 2.2.3 浜岃繘鍒朵笅杞?瀹夎瀹炵幇
- **鏂囦欢**: `crates/services/src/services/agent_binary.rs` (鏂板缓)
- **閫昏緫**:
  - 妫€娴?OS/鏋舵瀯
  - 浠?GitHub Releases / npm registry 涓嬭浇
  - 瑙ｅ帇鍒?`~/.vibex/bin/`
  - 鏇存柊 PATH锛堝彲閫夛級

### 2.3 鍓嶇 - Agent 璁剧疆缁勪欢

#### 2.3.1 涓婚〉闈㈢粍浠?
- **鏂囦欢**: `frontend/src/pages/settings/AgentSettings.tsx` (閲嶅啓)
- **鍙傝€?*: `code-referance/codeg/src/components/settings/acp-agent-settings.tsx`
- **缁撴瀯**:
  ```
  div.space-y-6
  鈹溾攢鈹€ Header: "浠ｇ悊璁剧疆" + 鎻忚堪
  鈹斺攢鈹€ Reorder.Group (Framer Motion 鎷栨嫿鎺掑簭)
      鈹溾攢鈹€ AgentCard[claude_code]
      鈹溾攢鈹€ AgentCard[codex]
      鈹斺攢鈹€ AgentCard[open_code]
  ```

#### 2.3.2 AgentCard 缁勪欢
- **鏂囦欢**: `frontend/src/components/settings/AgentCard.tsx` (鏂板缓)
- **缁撴瀯**:
  ```
  Reorder.Item
  鈹斺攢鈹€ Card
      鈹溾攢鈹€ CardHeader
      鈹?  鈹溾攢鈹€ 鎷栨嫿鎵嬫焺 (GripVertical)
      鈹?  鈹溾攢鈹€ Agent 鍥炬爣 + 鍚嶇О
      鈹?  鈹溾攢鈹€ 鐗堟湰 Badge
      鈹?  鈹斺攢鈹€ Enable/Disable Switch
      鈹溾攢鈹€ Preflight 妫€鏌ュ尯鍩?(鍙姌鍙?
      鈹?  鈹溾攢鈹€ CheckCircle / XCircle / AlertTriangle 鍥炬爣
      鈹?  鈹溾攢鈹€ 妫€鏌ユ秷鎭?
      鈹?  鈹斺攢鈹€ 淇鎸夐挳
      鈹溾攢鈹€ 閰嶇疆鍖哄煙 (Collapsible)
      鈹?  鈹溾攢鈹€ Agent 鐗瑰畾琛ㄥ崟
      鈹?  鈹溾攢鈹€ 鐜鍙橀噺缂栬緫鍣?
      鈹?  鈹斺攢鈹€ JSON 閰嶇疆缂栬緫鍣?
      鈹斺攢鈹€ 鎿嶄綔鎸夐挳
          鈹溾攢鈹€ Check (杩愯 Preflight)
          鈹溾攢鈹€ Download / Update
          鈹溾攢鈹€ Uninstall
          鈹斺攢鈹€ Save
  ```

#### 2.3.3 Agent 鐗瑰畾琛ㄥ崟 (閲嶅啓)
- **鏂囦欢**: `frontend/src/components/settings/agents/ClaudeCodeForm.tsx` (閲嶅啓)
  - API Base URL, API Key, Models Grid (Main, Reasoning, Haiku, Sonnet, Opus)
- **鏂囦欢**: `frontend/src/components/settings/agents/CodexForm.tsx` (閲嶅啓)
  - Provider, Model, API Base URL, API Key, Reasoning Effort, WebSocket, TOML, Auth JSON
- **鏂囦欢**: `frontend/src/components/settings/agents/OpenCodeForm.tsx` (閲嶅啓)
  - Model, Small Model, JSON Config, Auth JSON

#### 2.3.4 鏂板渚濊禆
- `framer-motion` (鎷栨嫿鎺掑簭)

### 2.4 鍓嶇 API

- **鏂囦欢**: `frontend/src/lib/api.ts`
- **鏂板**:
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

## Phase 3: MCP 璁剧疆椤甸潰 [棰勪及 4-6 灏忔椂]

### 鐩爣
绉绘 codeg 鐨?MCP 璁剧疆锛屽寘鍚湰鍦版壂鎻忓拰 Marketplace 鍔熻兘銆?

### 3.1 鍚庣 - MCP 鍛戒护澧炲己

#### 3.1.1 MCP 鎵弿鍜岀鐞?
- **鏂囦欢**: `src-tauri/src/commands/mcp_settings.rs` (鏂板缓鎴栨墿灞曠幇鏈?
- **鏂板鍛戒护**:
  | 鍛戒护 | 璇存槑 |
  |------|------|
  | `mcp_scan_local` | 鎵弿鏈湴宸插畨瑁呯殑 MCP 鏈嶅姟鍣?|
  | `mcp_upsert_local_server` | 鏂板/鏇存柊鏈湴 MCP 閰嶇疆 |
  | `mcp_remove_server` | 鍒犻櫎 MCP 鏈嶅姟鍣?|
  | `mcp_list_marketplaces` | 鍒楀嚭鍙敤 Marketplace |
  | `mcp_search_marketplace` | 鎼滅储 Marketplace |
  | `mcp_get_marketplace_detail` | 鑾峰彇 Marketplace 鏈嶅姟鍣ㄨ鎯?|
  | `mcp_install_from_marketplace` | 浠?Marketplace 瀹夎 |

### 3.2 鍓嶇 - MCP 璁剧疆缁勪欢

#### 3.2.1 涓婚〉闈?(閲嶅啓)
- **鏂囦欢**: `frontend/src/pages/settings/McpSettings.tsx` (閲嶅啓)
- **鍙傝€?*: `code-referance/codeg/src/components/settings/mcp-settings.tsx`
- **缁撴瀯**:
  ```
  div.flex.h-full
  鈹溾攢鈹€ Left Panel (w-80)
  鈹?  鈹溾攢鈹€ Tabs: Local | Marketplace
  鈹?  鈹溾攢鈹€ Local Tab:
  鈹?  鈹?  鈹溾攢鈹€ 鎼滅储妗?
  鈹?  鈹?  鈹斺攢鈹€ Server 鍒楄〃 (鍚嶇О + 鍗忚 badge)
  鈹?  鈹斺攢鈹€ Marketplace Tab:
  鈹?      鈹溾攢鈹€ Marketplace 閫夋嫨鍣?
  鈹?      鈹溾攢鈹€ 鎼滅储妗?
  鈹?      鈹斺攢鈹€ Server 鍒楄〃
  鈹斺攢鈹€ Right Panel (flex-1)
      鈹溾攢鈹€ Server 璇︽儏鍗?
      鈹?  鈹溾攢鈹€ 鍚嶇О + 鐗堟湰 + 鎻忚堪
      鈹?  鈹溾攢鈹€ Tools 鍒楄〃
      鈹?  鈹溾攢鈹€ Resources 鍒楄〃
      鈹?  鈹斺攢鈹€ Prompts 鍒楄〃
      鈹斺攢鈹€ 瀹夎鍚戝
          鈹溾攢鈹€ 鍗忚閫夋嫨 (stdio/sse/http)
          鈹溾攢鈹€ 鍔ㄦ€佸弬鏁拌〃鍗?
          鈹斺攢鈹€ 瀹夎鎸夐挳
  ```

---

## Phase 4: Skills 璁剧疆椤甸潰 [棰勪及 3-4 灏忔椂]

### 鐩爣
绉绘 codeg 鐨?Skills 缂栬緫鍣ㄣ€?

### 4.1 鍚庣 - Skills 鍛戒护

#### 4.1.1 Skills 璇诲啓
- **鏂囦欢**: `src-tauri/src/commands/skills.rs` (鏂板缓)
- **鍛戒护**:
  | 鍛戒护 | 璇存槑 |
  |------|------|
  | `list_agent_skills` | 鍒楀嚭鏌?Agent 鐨勬墍鏈?Skills |
  | `read_agent_skill` | 璇诲彇 Skill 鍐呭 |
  | `save_agent_skill` | 淇濆瓨 Skill |
  | `delete_agent_skill` | 鍒犻櫎 Skill |
  | `create_agent_skill` | 鍒涘缓鏂?Skill |

#### 4.1.2 Skills 鏈嶅姟灞?
- **鏂囦欢**: `crates/services/src/services/skills.rs` (鏂板缓)
- **閫昏緫**:
  - Claude Code Skills: 璇诲啓 `~/.claude/commands/` 鐩綍
  - Codex Skills: 璇诲啓 `~/.codex/skills/` 鎴栫被浼肩洰褰?
  - OpenCode Skills: 璇诲啓瀵瑰簲鐩綍

### 4.2 鍓嶇 - Skills 缁勪欢

#### 4.2.1 涓婚〉闈?
- **鏂囦欢**: `frontend/src/pages/settings/SkillsSettings.tsx` (鏂板缓)
- **鍙傝€?*: `code-referance/codeg/src/components/settings/skills-settings.tsx`
- **缁撴瀯**:
  ```
  div.flex.h-full
  鈹溾攢鈹€ Left Panel
  鈹?  鈹溾攢鈹€ Agent 閫夋嫨鍣?
  鈹?  鈹溾攢鈹€ 鎼滅储妗?
  鈹?  鈹溾攢鈹€ Skill 鍒楄〃
  鈹?  鈹斺攢鈹€ + 鏂板缓鎸夐挳
  鈹斺攢鈹€ Right Panel (鍒嗗壊闈㈡澘)
      鈹溾攢鈹€ 缂栬緫鍖?(Markdown + Front Matter)
      鈹斺攢鈹€ 棰勮鍖?(Markdown 娓叉煋)
  ```

---

## Phase 5: Shortcuts 璁剧疆椤甸潰 [棰勪及 2-3 灏忔椂]

### 鐩爣
绉绘 codeg 鐨勫揩鎹烽敭璁剧疆锛屾敮鎸佸綍鍒跺拰鍐茬獊妫€娴嬨€?

### 5.1 鍓嶇 - 蹇嵎閿粍浠?

#### 5.1.1 涓婚〉闈?
- **鏂囦欢**: `frontend/src/pages/settings/ShortcutSettings.tsx` (鏂板缓)
- **鍙傝€?*: `code-referance/codeg/src/components/settings/shortcut-settings.tsx`
- **缁撴瀯**:
  ```
  div.space-y-4
  鈹溾攢鈹€ Header: "蹇嵎閿? + "鎭㈠榛樿" 鎸夐挳
  鈹斺攢鈹€ 蹇嵎閿垪琛?
      鈹溾攢鈹€ 姣忚: 鎿嶄綔鍚嶇О | 蹇嵎閿寜閽?(鍙偣鍑诲綍鍒?
      鈹斺攢鈹€ 褰曞埗妯″紡: 鎹曡幏 keydown 鈫?楠岃瘉 鈫?淇濆瓨
  ```

#### 5.1.2 蹇嵎閿伐鍏峰簱
- **鏂囦欢**: `frontend/src/lib/keyboard-shortcuts.ts` (鏂板缓)
- **鍙傝€?*: `code-referance/codeg/src/lib/keyboard-shortcuts.ts`
- **瀵煎嚭**:
  ```typescript
  SHORTCUT_DEFINITIONS: ShortcutDefinition[]
  normalizeShortcut(raw: string): string | null
  shortcutFromKeyboardEvent(event, allowNoModifier?): string | null
  formatShortcutLabel(shortcut: string, isMac: boolean): string
  readShortcutSettings(): ShortcutSettings
  writeShortcutSettings(settings: ShortcutSettings): void
  ```

#### 5.1.3 蹇嵎閿?Hook
- **鏂囦欢**: `frontend/src/hooks/useShortcutSettings.ts` (鏂板缓)

#### 5.1.4 蹇嵎閿畾涔?(閫傞厤 VibeX)
```typescript
const SHORTCUT_DEFINITIONS = [
  { id: "toggle_search", defaultKey: "mod+k", label: "鎼滅储" },
  { id: "toggle_sidebar", defaultKey: "mod+b", label: "鍒囨崲渚ф爮" },
  { id: "toggle_terminal", defaultKey: "mod+j", label: "鍒囨崲缁堢" },
  { id: "new_terminal_tab", defaultKey: "mod+t", label: "鏂板缓缁堢鏍囩" },
  { id: "close_terminal_tab", defaultKey: "mod+w", label: "鍏抽棴缁堢鏍囩" },
  { id: "open_settings", defaultKey: "mod+,", label: "鎵撳紑璁剧疆" },
  { id: "send_message", defaultKey: "enter", label: "鍙戦€佹秷鎭? },
  { id: "newline_in_message", defaultKey: "shift+enter", label: "娑堟伅鎹㈣" },
  // ... 鍙牴鎹?VibeX 瀹為檯闇€姹傝皟鏁?
]
```

### 5.2 瀛樺偍
- `localStorage['vibex-shortcuts:v1']` - JSON 鏍煎紡

---

## Phase 6: System 璁剧疆椤甸潰 [棰勪及 2-3 灏忔椂]

### 鐩爣
灏嗙幇鏈?GeneralSettings 閲嶆瀯涓?codeg 椋庢牸鐨?System 璁剧疆椤甸潰銆?

### 6.1 鍚庣 - 绯荤粺璁剧疆鍛戒护

#### 6.1.1 浠ｇ悊璁剧疆 (鍙€夛紝濡傞渶 HTTP 浠ｇ悊)
- **鏂囦欢**: 鎵╁睍 `src-tauri/src/commands/config.rs`
- **鏂板**: `get_proxy_settings`, `update_proxy_settings`

### 6.2 鍓嶇 - System 缁勪欢

#### 6.2.1 涓婚〉闈?
- **鏂囦欢**: `frontend/src/pages/settings/SystemSettings.tsx` (鏂板缓锛屾浛浠?GeneralSettings)
- **鍙傝€?*: `code-referance/codeg/src/components/settings/system-network-settings.tsx`
- **缁撴瀯**:
  ```
  div.space-y-8
  鈹溾攢鈹€ Section: 澶栬
  鈹?  鈹斺攢鈹€ 涓婚閫夋嫨 (System / Light / Dark)
  鈹溾攢鈹€ Section: 浜や簰
  鈹?  鈹溾攢鈹€ 鍙戦€佹秷鎭揩鎹烽敭
  鈹?  鈹斺攢鈹€ 榛樿缁堢 Shell
  鈹溾攢鈹€ Section: 缂栬緫鍣?
  鈹?  鈹溾攢鈹€ 缂栬緫鍣ㄧ被鍨嬮€夋嫨
  鈹?  鈹斺攢鈹€ 鑷畾涔夊懡浠?
  鈹溾攢鈹€ Section: Git
  鈹?  鈹溾攢鈹€ 鍒嗘敮鍚嶅墠缂€
  鈹?  鈹溾攢鈹€ 宸ヤ綔鍖虹洰褰?
  鈹?  鈹斺攢鈹€ 鎻愪氦鎻愰啋
  鈹溾攢鈹€ Section: 閫氱煡
  鈹?  鈹溾攢鈹€ 澹伴煶寮€鍏?+ 閫夋嫨
  鈹?  鈹斺攢鈹€ 鎺ㄩ€侀€氱煡
  鈹溾攢鈹€ Section: 搴旂敤鏇存柊
  鈹?  鈹溾攢鈹€ 褰撳墠鐗堟湰
  鈹?  鈹溾攢鈹€ 妫€鏌ユ洿鏂版寜閽?
  鈹?  鈹斺攢鈹€ 鏇存柊鏃ュ織
  鈹斺攢鈹€ Section: 閲嶇疆
      鈹溾攢鈹€ 閲嶇疆鍏嶈矗澹版槑
      鈹斺攢鈹€ 閲嶇疆鍏ラ棬娴佺▼
  ```

---

## Phase 7: 娓呯悊鍜岄泦鎴?[棰勪及 2-3 灏忔椂]

### 浠诲姟

#### 7.1 绉婚櫎鏃ц缃〉闈?
- 鍒犻櫎: `frontend/src/pages/settings/ProjectSettings.tsx`
- 鍒犻櫎: `frontend/src/pages/settings/ReposSettings.tsx`
- 鏇存柊: `frontend/src/pages/settings/index.ts` 瀵煎嚭

#### 7.2 涓荤獥鍙ｈ缃叆鍙?
- 绉婚櫎涓荤獥鍙ｄ腑鐨?`/settings` 璺敱瀵艰埅锛圫idebar 绛夛級
- 纭繚 `Ctrl+,` 蹇嵎閿叏灞€鐢熸晥
- Toolbar 涓坊鍔犻娇杞浘鏍囨寜閽?

#### 7.3 绐楀彛闂撮€氫俊
- 璁剧疆绐楀彛淇濆瓨閰嶇疆鍚庯紝涓荤獥鍙ｉ渶瑕佸埛鏂?
- 浣跨敤 Tauri Events: `settings-updated` 浜嬩欢
- 涓荤獥鍙ｇ洃鍚簨浠跺苟 `reloadSystem()`

#### 7.4 绫诲瀷鏇存柊
- 杩愯 `cargo run --bin generate-types` 鏇存柊 `shared/types.ts`
- 纭繚鎵€鏈夋柊绫诲瀷姝ｇ‘瀵煎嚭

---

## 鏂囦欢鍙樻洿娓呭崟

### 鏂板缓鏂囦欢 (~25 涓?

**鍚庣 (Rust)**:
1. `src-tauri/src/commands/settings_window.rs` - 绐楀彛绠＄悊
2. `src-tauri/src/commands/agent_settings.rs` - Agent 璁剧疆鍛戒护
3. `src-tauri/src/commands/mcp_settings.rs` - MCP 璁剧疆鍛戒护 (鎵╁睍)
4. `src-tauri/src/commands/skills.rs` - Skills 鍛戒护
5. `crates/db/migrations/YYYYMMDD_agent_setting.sql` - 鏁版嵁搴撹縼绉?
6. `crates/db/src/agent_setting.rs` - Agent 璁剧疆 CRUD
7. `crates/services/src/services/agent_preflight.rs` - Preflight 妫€鏌?
8. `crates/services/src/services/agent_binary.rs` - 浜岃繘鍒剁鐞?
9. `crates/services/src/services/skills.rs` - Skills 鏈嶅姟
10. `crates/api-types/src/agent_settings.rs` - Agent 璁剧疆绫诲瀷

**鍓嶇 (TypeScript/React)**:
11. `frontend/src/pages/settings/SettingsWindow.tsx` - 绐楀彛鏍圭粍浠?
12. `frontend/src/pages/settings/SkillsSettings.tsx` - Skills 椤甸潰
13. `frontend/src/pages/settings/ShortcutSettings.tsx` - 蹇嵎閿〉闈?
14. `frontend/src/pages/settings/SystemSettings.tsx` - 绯荤粺璁剧疆
15. `frontend/src/components/settings/AgentCard.tsx` - Agent 鍗＄墖
16. `frontend/src/components/settings/agents/ClaudeCodeForm.tsx` - Claude 琛ㄥ崟 (閲嶅啓)
17. `frontend/src/components/settings/agents/CodexForm.tsx` - Codex 琛ㄥ崟 (閲嶅啓)
18. `frontend/src/components/settings/agents/OpenCodeForm.tsx` - OpenCode 琛ㄥ崟 (閲嶅啓)
19. `frontend/src/components/settings/McpServerCard.tsx` - MCP 鏈嶅姟鍣ㄥ崱鐗?
20. `frontend/src/components/settings/SkillEditor.tsx` - Skill 缂栬緫鍣?
21. `frontend/src/lib/keyboard-shortcuts.ts` - 蹇嵎閿伐鍏?
22. `frontend/src/hooks/useShortcutSettings.ts` - 蹇嵎閿?Hook
23. `frontend/src/hooks/useAgentSettings.ts` - Agent 璁剧疆 Hook (鏂?

### 淇敼鏂囦欢 (~15 涓?

1. `src-tauri/src/lib.rs` - 娉ㄥ唽鏂板懡浠?
2. `src-tauri/tauri.conf.json` - 绐楀彛鏉冮檺閰嶇疆
3. `frontend/src/App.tsx` - 璺敱鏇存柊
4. `frontend/src/pages/settings/SettingsLayout.tsx` - 甯冨眬閲嶅啓
5. `frontend/src/pages/settings/AgentSettings.tsx` - 瀹屽叏閲嶅啓
6. `frontend/src/pages/settings/McpSettings.tsx` - 瀹屽叏閲嶅啓
7. `frontend/src/pages/settings/index.ts` - 瀵煎嚭鏇存柊
8. `frontend/src/lib/api.ts` - 鏂板 API 灏佽
9. `frontend/src/lib/agentConfigUtils.ts` - 閫傞厤鏂版暟鎹粨鏋?
10. `frontend/src/components/layout/Toolbar.tsx` - 娣诲姞璁剧疆鎸夐挳
11. `frontend/src/components/ConfigProvider.tsx` - 閫傞厤鏂版暟鎹祦
12. `crates/db/src/lib.rs` - 娉ㄥ唽鏂版ā鍧?
13. `crates/services/src/lib.rs` - 娉ㄥ唽鏂版湇鍔?
14. `crates/api-types/src/lib.rs` - 娉ㄥ唽鏂扮被鍨?
15. `frontend/package.json` - 娣诲姞 framer-motion 渚濊禆

### 鍒犻櫎鏂囦欢 (~2 涓?

1. `frontend/src/pages/settings/ProjectSettings.tsx`
2. `frontend/src/pages/settings/ReposSettings.tsx`

---

## 瀹炴柦椤哄簭鍜屼緷璧栧叧绯?

```
Phase 0 (鐙珛绐楀彛) 鈹€鈹€鈹?
                      鈹溾攢鈹€鈫?Phase 1 (Shell 甯冨眬) 鈹€鈹€鈫?Phase 6 (System)
                      鈹?                         鈹€鈹€鈫?Phase 5 (Shortcuts)
Phase 2.1 (DB 灞?  鈹€鈹€鈹?
Phase 2.2 (鍛戒护灞? 鈹€鈹€鈹も攢鈹€鈫?Phase 2.3 (Agent UI) 鈹€鈹€鈫?Phase 3 (MCP)
                      鈹?                         鈹€鈹€鈫?Phase 4 (Skills)
                      鈹斺攢鈹€鈫?Phase 7 (娓呯悊闆嗘垚)
```

**寤鸿鎵ц椤哄簭**: 0 鈫?1 鈫?2 鈫?6 鈫?5 鈫?3 鈫?4 鈫?7

---

## 椋庨櫓鍜屾敞鎰忎簨椤?

1. **profiles.json 鍏煎鎬?*: 鏂板 agent_setting 琛ㄥ悗锛岄渶纭繚涓庣幇鏈?profiles.json 鏁版嵁鍙屽悜鍚屾
2. **浜岃繘鍒朵笅杞藉畨鍏?*: 闇€楠岃瘉涓嬭浇婧愮殑鍙俊搴︼紝浣跨敤 SHA256 鏍￠獙
3. **璺ㄥ钩鍙拌矾寰?*: Windows/macOS/Linux 鐨勯厤缃枃浠惰矾寰勪笉鍚岋紝闇€浣跨敤 `dirs` crate
4. **绐楀彛鐢熷懡鍛ㄦ湡**: 鐙珛绐楀彛鍏抽棴鏃堕渶姝ｇ‘娓呯悊璧勬簮
5. **Framer Motion 鍏煎**: 纭涓庣幇鏈夊姩鐢诲簱鏃犲啿绐?
6. **浠ｇ爜閲忓ぇ**: Agent 璁剧疆椤甸潰绾?5000+ 琛岋紝寤鸿鎷嗗垎涓哄涓瓙缁勪欢锛圓gentCard銆丗orms 绛夛級
