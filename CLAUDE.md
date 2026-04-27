AGENTS.md

# VibeX 鈥?Claude 椤圭洰瑙勫垯鏂囨。

> 鏈枃妗ｄ负 AI 缂栫▼鍔╂墜鎻愪緵瀹屾暣鐨勯」鐩笂涓嬫枃锛屽寘鍚灦鏋勮鏄庛€佺紪鐮佽鑼冦€佹湳璇槧灏勫拰鐢ㄦ埛鑷畾涔夎鍒欍€?

---

## 涓€銆侀」鐩畝浠?

**VibeX** 鏄熀浜?[vibe-kanban](https://github.com/BloopAI/vibe-kanban) fork銆侀拡瀵规闈㈢浣撻獙娣卞害浼樺寲鐨?AI 缂栫▼ Agent 浠诲姟绠＄悊宸ュ叿锛屼娇鐢?**Tauri v2** 鏋勫缓銆?

鏍稿績鐩爣锛氳 Claude Code銆丟emini CLI銆丆odex銆丄mp 绛?AI 缂栫▼ Agent 鐨勭敓浜у姏鎻愬崌 10 鍊嶏紝鏀寔澶?Agent 骞惰璋冨害銆佺湅鏉垮紡浠诲姟绠＄悊銆佸唴缃粓绔€佷唬鐮侀瑙堜笌 Diff 瀹℃煡銆?

**涓庝笂娓哥殑涓昏宸紓锛?*
- 鍘婚櫎浜戝悓姝ャ€丱Auth 绛夌涓夋柟渚濊禆
- 涓撴敞妗岄潰绔師鐢熶綋楠岋紙Tauri v2锛?
- 闆嗘垚鏇村 IDE 甯冨眬鍔熻兘锛坉ockview 澶氶潰鏉匡級

---

## 浜屻€佹妧鏈爤

### 2.1 鍓嶇

| 鎶€鏈?| 鐗堟湰/璇存槑 |
|---|---|
| React | 18锛屽嚱鏁板紡缁勪欢 + Hooks |
| TypeScript | 涓ユ牸妯″紡 |
| Vite | 鏋勫缓宸ュ叿 |
| dockview-react | v5.1.0锛孖DE 澶氶潰鏉垮竷灞€绠＄悊 |
| xterm.js | 缁堢妯℃嫙锛圥TY 閫氳繃 Tauri 鍚庣瀹炵幇锛?|
| Monaco Editor | 浠ｇ爜缂栬緫/Diff 棰勮 |
| TanStack Query | 鏈嶅姟绔姸鎬佺鐞?|
| Zustand | 瀹㈡埛绔姸鎬佺鐞嗭紙鍚?persist 涓棿浠讹級 |
| react-router-dom | v6锛岃矾鐢辩鐞?|
| Tailwind CSS | 鏍峰紡 |

### 2.2 鍚庣锛圧ust锛?

| 鎶€鏈?| 璇存槑 |
|---|---|
| Tauri v2 | 妗岄潰搴旂敤瀹瑰櫒锛孋ommands & Events |
| Tokio | 寮傛杩愯鏃?|
| Axum 0.8 | HTTP 鏈嶅姟锛圡CP銆丄PI锛?|
| SQLite (sqlx) | 鏈湴鏁版嵁鎸佷箙鍖?|
| git2 | Git 鎿嶄綔锛坉iff銆乥ranch銆亀orktree銆乺ebase锛?|
| ts-rs | Rust 缁撴瀯浣?鈫?TypeScript 绫诲瀷鑷姩鐢熸垚 |
| serde / serde_json | 搴忓垪鍖?|
| tracing | 鏃ュ織 |

### 2.3 鏋勫缓宸ュ叿

- **pnpm workspace** + `pnpm-workspace.yaml`锛堝墠绔寘绠＄悊锛?
- **Cargo workspace**锛堟墍鏈?Rust crate 缁熶竴绠＄悊锛?
- `shared/types.ts`锛氱敱 `cargo run --bin generate-types` 鑷姩鐢熸垚锛?*绂佹鎵嬪姩淇敼**

---

## 涓夈€侀」鐩灦鏋?

### 3.1 鐩綍缁撴瀯

```
VibeX/
鈹溾攢鈹€ frontend/                  鍓嶇锛圧eact + Vite锛?
鈹?  鈹斺攢鈹€ src/
鈹?      鈹溾攢鈹€ App.tsx            璺敱鏍?
鈹?      鈹溾攢鈹€ components/        UI 缁勪欢
鈹?      鈹?  鈹溾攢鈹€ layout/        甯冨眬缁勪欢锛圛DELayout銆乀oolbar 绛夛級
鈹?      鈹?  鈹溾攢鈹€ panels/        dockview 闈㈡澘缁勪欢
鈹?      鈹?  鈹斺攢鈹€ tasks/         浠诲姟鐩稿叧缁勪欢
鈹?      鈹溾攢鈹€ contexts/          React Context 鎻愪緵鑰?
鈹?      鈹溾攢鈹€ stores/            Zustand 鐘舵€?Store
鈹?      鈹溾攢鈹€ hooks/             鑷畾涔?Hooks
鈹?      鈹溾攢鈹€ lib/               宸ュ叿搴擄紙api.ts 绛夛級
鈹?      鈹斺攢鈹€ pages/             璺敱椤甸潰
鈹溾攢鈹€ src-tauri/                 Tauri 鍏ュ彛锛圧ust锛?
鈹?  鈹斺攢鈹€ src/commands/          Tauri Command 瀹炵幇
鈹溾攢鈹€ crates/
鈹?  鈹溾攢鈹€ api-types/             鍏变韩 API 绫诲瀷锛堚啋 shared/types.ts锛?
鈹?  鈹溾攢鈹€ db/                    鏁版嵁搴撳眰锛歋QLite schema銆乵igrations銆丆RUD
鈹?  鈹溾攢鈹€ services/              涓氬姟閫昏緫灞傦細浠诲姟銆佷細璇濄€乨iff 娴併€乹ueue
鈹?  鈹溾攢鈹€ git/                   Git 鎿嶄綔灏佽
鈹?  鈹溾攢鈹€ executors/             AI 鎵ц鍣紙Claude Code 绛?agent 鎶借薄锛?
鈹?  鈹溾攢鈹€ deployment/            閮ㄧ讲绠＄悊锛欰ppState 鍒濆鍖栥€佷簨浠惰浆鍙?
鈹?  鈹溾攢鈹€ local-deployment/      鏈湴閮ㄧ讲瀹炵幇
鈹?  鈹斺攢鈹€ utils/                 閫氱敤宸ュ叿鍑芥暟
鈹溾攢鈹€ shared/
鈹?  鈹斺攢鈹€ types.ts               鑷姩鐢熸垚鐨?TS 绫诲瀷锛堝嬁鎵嬪姩淇敼锛?
鈹溾攢鈹€ code-referance/            绔炲搧/鍙傝€冮」鐩洰褰曪紙瑙佺敤鎴疯鍒欙級
鈹溾攢鈹€ docs/                      鏂囨。
鈹斺攢鈹€ vendor/                    Patched 绗笁鏂瑰簱锛坈odex-windows-sandbox 绛夛級
```

### 3.2 鏁版嵁娴?

```
鐢ㄦ埛鎿嶄綔锛堝墠绔級
    鈹?
    鈻?
tauriInvoke('command_name', args)     鈫?鍓嶇 lib/api.ts 灏佽鐨?IPC 璋冪敤
    鈹?
    鈻?
src-tauri/src/commands/*.rs           鈫?Tauri Command 澶勭悊灞?
    鈹?
    鈻?
crates/services/                      鈫?涓氬姟閫昏緫
    鈹溾攢鈹€ crates/db/                    鈫?鏁版嵁鎸佷箙鍖栵紙SQLite锛?
    鈹斺攢鈹€ crates/git/                   鈫?Git 鎿嶄綔
    鈹?
    鈻?
Tauri Events锛圫SE-like 娴佸紡锛?         鈫?瀹炴椂鎺ㄩ€侊紙diff stream銆乧onversation stream锛?
    鈹?
    鈻?
鍓嶇 useQuery / EventSource 璁㈤槄
```

### 3.3 鍓嶇甯冨眬灞傛

```
App.tsx锛堣矾鐢辨牴锛?
鈹斺攢鈹€ IDEWorkspaceRoute         /local-projects/:projectId/tasks/*
      鈹斺攢鈹€ WorkspaceLayout     Context 娉ㄥ叆灞?
            鈹? providers: WorktreeProvider 鈫?ReviewProvider
            鈹?            鈫?TerminalProvider 鈫?PanelActionsProvider
            鈹斺攢鈹€ IDELayout     dockview 甯冨眬瀹瑰櫒
                  鈹溾攢鈹€ Toolbar锛堥《閮ㄥ伐鍏锋爮锛?
                  鈹溾攢鈹€ ActivityBar锛堝乏渚у浘鏍囨爮锛屽 40px锛?
                  鈹溾攢鈹€ DockviewReact锛堝闈㈡澘绠＄悊锛?
                  鈹?    鈹溾攢鈹€ group-left     鈫?FileTree / Git
                  鈹?    鈹溾攢鈹€ group-center-1 鈫?Kanban / Diffs / Preview / Logs / Notes / Welcome
                  鈹?    鈹溾攢鈹€ group-center-2 鈫?锛堜笌 center-1 骞舵帓锛?
                  鈹?    鈹斺攢鈹€ group-bottom   鈫?Terminal
                  鈹溾攢鈹€ KanbanBoard锛圞anban Tab 婵€娲绘椂鍏ㄥ睆瑕嗙洊灞傦級
                  鈹溾攢鈹€ RightPanelContent锛堝彸渚у浐瀹氶潰鏉匡紝涓嶅彈 dockview 绠＄悊锛?
                  鈹?    鈹溾攢鈹€ BranchInfoHeader
                  鈹?    鈹溾攢鈹€ Outlet锛圱askPanel / TaskAttemptPanel锛?
                  鈹?    鈹斺攢鈹€ RightPanelSidebar
                  鈹斺攢鈹€ StatusBar锛堝簳閮ㄧ姸鎬佹爮锛?
```

---

## 鍥涖€佹湳璇鏄?

### 4.1 甯冨眬鍖哄煙鏈

| 鐢ㄦ埛鏈 | 鎶€鏈湳璇?| Group ID 甯搁噺 | 璇存槑 |
|---|---|---|---|
| **宸︽爮** | Left Sidebar | `GROUP_IDS.LEFT = 'group-left'` | 鏂囦欢鏍?Git 闈㈡澘锛屾棤鏍囩澶达紙`dv-header-hidden`锛?|
| **涓?鏍?* | Center-1 | `GROUP_IDS.CENTER_1 = 'group-center-1'` | 涓荤紪杈戝尯宸﹀崐閮ㄥ垎 |
| **涓?鏍?* | Center-2 | `GROUP_IDS.CENTER_2 = 'group-center-2'` | 涓荤紪杈戝尯鍙冲崐閮ㄥ垎锛屼笌 Center-1 骞舵帓 |
| **缁堢鏍?* | Bottom Terminal | `GROUP_IDS.BOTTOM = 'group-bottom'` | 搴曢儴缁堢/鏃ュ織闈㈡澘 |
| **鍙虫爮** | Right Fixed Panel | 鈥?| AI 瀵硅瘽鍖猴紝鍥哄畾瀹藉害锛堥粯璁?500px锛夛紝**涓嶅彈 dockview 绠＄悊** |
| **娲诲姩鏍?* | Activity Bar | 鈥?| 鏈€宸︿晶鍥炬爣鏍忥紙瀹?40px锛?|
| **宸ュ叿鏍?* | Toolbar | 鈥?| 椤堕儴宸ュ叿鏍?|
| **鐘舵€佹爮** | StatusBar | 鈥?| 搴曢儴鐘舵€佹爮 |

### 4.2 闈㈡澘 ID 鈫?缁勪欢鏄犲皠

| Panel ID | 甯搁噺 | 缁勪欢鏂囦欢 | 璇存槑 |
|---|---|---|---|
| `kanban` | `PANEL_IDS.KANBAN` | `DockviewKanbanPanel` | 鐪嬫澘锛堝叏灞忚鐩栧眰娓叉煋锛宒ockview 浠呭崰浣嶏級 |
| `file-tree` | `PANEL_IDS.FILE_TREE` | `DockviewFileTreePanel` | 鏂囦欢鏍戞祻瑙堝櫒 |
| `git` | `PANEL_IDS.GIT` | `DockviewGitPanel` | Git 鐘舵€?鎿嶄綔绠＄悊鍣?|
| `terminal` | `PANEL_IDS.TERMINAL` | `DockviewTerminalPanel` | xterm.js + Tauri PTY锛屾敮鎸佸 tab |
| `diffs` | `PANEL_IDS.DIFFS` | `DockviewDiffsReviewPanel` | Diff 瀹℃煡锛屾敮鎸佷唬鐮佹敞閲?|
| `preview` | `PANEL_IDS.PREVIEW` | `DockviewPreviewPanel` | 鍐呭祵 webview 棰勮 |
| `welcome` | `PANEL_IDS.WELCOME` | `DockviewWelcomePanel` | 绌虹櫧鍗犱綅娆㈣繋椤?|
| `logs` | `PANEL_IDS.LOGS` | `DockviewLogsPanel` | 鎵ц鏃ュ織鏌ョ湅鍣?|
| `notes` | `PANEL_IDS.NOTES` | `DockviewNotesPanel` | 宸ヤ綔鍖虹瑪璁?|
| `ai-chat` | `PANEL_IDS.AI_CHAT` | 鈥?| 浠呮敞鍐屽崰浣嶏紝瀹為檯 AI Chat 鍦ㄥ彸渚у浐瀹氶潰鏉?|

### 4.3 涓氬姟鏈

| 鏈 | 璇存槑 |
|---|---|
| **Task锛堜换鍔★級** | 鐪嬫澘涓殑涓€寮犲崱鐗囷紝浠ｈ〃涓€涓瀹屾垚鐨勫姛鑳?闇€姹?|
| **Attempt锛堝皾璇曪級** | 瀵规煇涓?Task 鐨勪竴娆?AI 鎵ц灏濊瘯锛屽寘鍚畬鏁寸殑瀵硅瘽鍘嗗彶 |
| **Session锛堜細璇濓級** | 涓€娆?AI Agent 杩愯瀹炰緥锛屽搴斾竴涓?Attempt |
| **Worktree锛堝伐浣滄爲锛?* | Git Worktree锛屾瘡涓?Task 瀵瑰簲涓€涓嫭绔嬬殑 git worktree锛岄殧绂讳唬鐮佸彉鏇?|
| **Executor锛堟墽琛屽櫒锛?* | AI 缂栫▼ Agent 鐨勬娊璞★紝褰撳墠鏀寔 Claude Code銆丆odex銆丄CP銆丱penCode 绛?|
| **Profile锛堥厤缃柟妗堬級** | AI 鎵ц鍣ㄧ殑涓€缁勯厤缃紙妯″瀷銆佹潈闄愩€佺幆澧冨彉閲忕瓑锛?|
| **Permission Mode锛堟潈闄愭ā寮忥級** | `auto`锛堣嚜鍔級/ `ask`锛堣闂級/ `plan`锛堣鍒掞級涓夌 AI 鎵ц鏉冮檺 |
| **MCP** | Model Context Protocol锛孉I Agent 涓婁笅鏂囧崗璁?|
| **Follow-up锛堣拷闂級** | 鍦ㄥ凡鏈?Attempt 鍩虹涓婂彂閫佹柊娑堟伅缁х画瀵硅瘽 |
| **Diff Stream** | 瀹炴椂鎺ㄩ€佷唬鐮佸彉鏇寸殑 SSE-like 娴?|

### 4.4 閰嶇疆鏂囦欢浣嶇疆

| 鏂囦欢 | 璇存槑 |
|---|---|
| `~/.claude/settings.json` | Claude Code 璁剧疆锛歟nv 鍙橀噺銆乪nabledPlugins銆乸ermissions |
| `~/.vibex/config.json` | 搴旂敤鍏ㄥ眬閰嶇疆 |
| `~/.vibex/profiles.json` | AI 鎵ц鍣?profiles 閰嶇疆 |
| `~/.vibex/vibex.db` | SQLite 鏁版嵁搴擄紙鏈湴瀛樺偍锛?|
| `localStorage['vibex-ide-layout']` | IDE 甯冨眬鎸佷箙鍖栵紙dockview JSON锛岀増鏈?8锛?|

---

## 浜斻€佺紪鐮佽鑼?

### 5.1 閫氱敤瑙勮寖

- **鏂囦欢澶у皬**锛氶€氬父 200鈥?00 琛岋紝鏈€澶?800 琛岋紱瓒呭嚭鏃舵彁鍙栧伐鍏峰嚱鏁?
- **鍑芥暟闀垮害**锛氬崟鍑芥暟涓嶈秴杩?50 琛?
- **鍛藉悕**锛氳涔夊寲銆佹竻鏅帮紱缁勪欢鐢?PascalCase锛屽嚱鏁?鍙橀噺鐢?camelCase锛孯ust 鐢?snake_case
- **涓嶅彲鍙樻€?*锛欽S/TS 涓缁堝垱寤烘柊瀵硅薄锛岀姝㈢洿鎺ヤ慨鏀瑰師瀵硅薄锛坄user.name = x` 鈫?`{...user, name: x}`锛?
- **绂佹 `console.log`**锛氳皟璇曞畬鎴愬悗蹇呴』鍒犻櫎

### 5.2 TypeScript / React

- 涓ユ牸妯″紡 TypeScript锛屾墍鏈夌粍浠跺繀椤绘湁鏄庣‘绫诲瀷
- 浼樺厛浣跨敤鍑芥暟寮忕粍浠?+ Hooks
- 浣跨敤 TanStack Query 绠＄悊鏈嶅姟绔姸鎬侊紙璇锋眰銆佺紦瀛樸€佸悓姝ワ級
- 浣跨敤 Zustand 绠＄悊绾鎴风鐘舵€?
- `shared/types.ts` 鏄嚜鍔ㄧ敓鎴愭枃浠讹紝**绂佹鎵嬪姩淇敼**锛岀被鍨嬪彉鏇村湪瀵瑰簲 Rust 缁撴瀯浣撲腑杩涜
- Tauri IPC 璋冪敤缁熶竴灏佽鍦?`frontend/src/lib/api.ts`锛屼笉鍦ㄧ粍浠朵腑鐩存帴璋冪敤 `invoke`

```typescript
// 姝ｇ‘锛氫娇鐢?api.ts 灏佽
import { api } from '@/lib/api'
const result = await api.getWorkspace(id)

// 閿欒锛氱洿鎺ュ湪缁勪欢涓皟鐢?invoke
import { invoke } from '@tauri-apps/api/core'
const result = await invoke('get_workspace', { id })
```

### 5.3 Rust

- 浣跨敤 `anyhow::Result` 澶勭悊閿欒锛宍thiserror` 瀹氫箟棰嗗煙閿欒绫诲瀷
- 鏁版嵁搴撴搷浣滀娇鐢?`sqlx`锛屽紓姝ユ煡璇?
- 鍏叡 API 绫诲瀷鍦?`crates/api-types/` 涓畾涔夛紝娣诲姞 `#[derive(ts_rs::TS)]` 浠ヨ嚜鍔ㄧ敓鎴?TS 绫诲瀷
- Tauri Command 鍑芥暟鏀惧湪 `src-tauri/src/commands/` 瀵瑰簲妯″潡涓?
- 淇敼 API 绫诲瀷鍚庨渶閲嶆柊杩愯 `cargo run --bin generate-types` 鏇存柊 `shared/types.ts`

### 5.4 甯冨眬涓?dockview

- Group ID 缁熶竴浣跨敤 `GROUP_IDS` 甯搁噺锛孭anel ID 浣跨敤 `PANEL_IDS` 甯搁噺
- 宸︽爮瀹藉害涓婇檺 40%锛岄€氳繃 `onDidLayoutChange` 鍔ㄦ€佸す绱?
- `api.fromJSON()` 鍚庡竷灞€灏哄闇€瑕?`setTimeout(100ms)` 寤惰繜鎵嶈兘鑾峰彇鐪熷疄 DOM 灏哄
- 甯冨眬鎸佷箙鍖栧瓨鍦?`localStorage`锛宬ey 涓?`vibex-ide-layout`锛岀増鏈彉鏇撮渶鍚屾鏇存柊鐗堟湰鍙?

---

## 鍏€佸叧閿枃浠堕€熸煡

```
frontend/src/
鈹溾攢鈹€ App.tsx                              璺敱鏍?
鈹溾攢鈹€ lib/api.ts                           鎵€鏈?Tauri IPC 璋冪敤灏佽锛堝敮涓€鍏ュ彛锛?
鈹溾攢鈹€ components/
鈹?  鈹溾攢鈹€ layout/
鈹?  鈹?  鈹溾攢鈹€ IDELayout.tsx                涓诲竷灞€锛坉ockview + 鍙充晶闈㈡澘锛?
鈹?  鈹?  鈹溾攢鈹€ IDEWorkspaceRoute.tsx        璺敱灞傜粍鍚?
鈹?  鈹?  鈹溾攢鈹€ WorkspaceLayout.tsx          Context 娉ㄥ叆灞?
鈹?  鈹?  鈹溾攢鈹€ RightPanelContent.tsx        鍙充晶鍥哄畾闈㈡澘鍐呭
鈹?  鈹?  鈹溾攢鈹€ Toolbar.tsx                  椤堕儴宸ュ叿鏍?
鈹?  鈹?  鈹溾攢鈹€ BranchInfoHeader.tsx         鍒嗘敮淇℃伅澶?
鈹?  鈹?  鈹斺攢鈹€ panels/PanelRegistry.tsx     闈㈡澘娉ㄥ唽琛?
鈹?  鈹溾攢鈹€ panels/
鈹?  鈹?  鈹溾攢鈹€ DockviewTerminalPanel.tsx    缁堢闈㈡澘
鈹?  鈹?  鈹斺攢鈹€ DockviewDiffsReviewPanel.tsx Diff 瀹℃煡闈㈡澘
鈹?  鈹斺攢鈹€ tasks/
鈹?      鈹溾攢鈹€ PermissionSelector.tsx       鏉冮檺閫夋嫨鍣紙auto/ask/plan锛?
鈹?      鈹溾攢鈹€ ModelSelector.tsx            妯″瀷閫夋嫨鍣?
鈹?      鈹溾攢鈹€ PluginSelector.tsx           鎻掍欢閫夋嫨鍣?
鈹?      鈹斺攢鈹€ TaskFollowUpSection.tsx      涓?AI 杈撳叆鍖?
鈹溾攢鈹€ stores/
鈹?  鈹斺攢鈹€ useLayoutStore.ts                甯冨眬鐘舵€侊紙Zustand + persist锛?
鈹斺攢鈹€ hooks/
    鈹斺攢鈹€ useClaudeSettings.ts             璇诲彇 ~/.claude/settings.json

src-tauri/src/commands/
鈹溾攢鈹€ config.rs                            get/update_claude_settings
鈹溾攢鈹€ file_tree.rs                         read_file_content銆乬et_file_at_head
鈹溾攢鈹€ sessions.rs                          follow_up銆乺eset_session_process
鈹斺攢鈹€ workspaces.rs                        branch/git/merge/rebase 鎿嶄綔

crates/
鈹溾攢鈹€ executors/src/executors/             鍚?AI Agent 鎵ц鍣ㄥ疄鐜?
鈹?  鈹溾攢鈹€ claude.rs                        Claude Code 鎵ц鍣?
鈹?  鈹溾攢鈹€ codex/                           Codex 鎵ц鍣?
鈹?  鈹溾攢鈹€ acp/                             ACP 鎵ц鍣?
鈹?  鈹斺攢鈹€ opencode/                        OpenCode 鎵ц鍣?
鈹斺攢鈹€ services/                            涓氬姟閫昏緫灞?

shared/types.ts                          鑷姩鐢熸垚锛堝嬁鎵嬪姩淇敼锛?
```

---

## 涓冦€佸紑鍙戝伐浣滄祦

### 鍚姩寮€鍙戠幆澧?

```bash
pnpm install           # 瀹夎鍓嶇渚濊禆
pnpm run dev           # 鍚姩 Tauri 寮€鍙戞ā寮忥紙鑷姩 vite build --watch锛?
```

### 浠呮瀯寤哄墠绔?

```bash
cd frontend && pnpm build
```

### 鏇存柊 TS 绫诲瀷锛堜慨鏀?Rust API 绫诲瀷鍚庯級

```bash
cargo run --bin generate-types
```

### 甯哥敤宸ュ叿

```bash
cargo install cargo-watch    # Rust 鐑噸杞借緟鍔?
cargo install sqlx-cli       # SQLite 杩佺Щ绠＄悊
```

### 宸茬煡鏋舵瀯闄愬埗

| 闄愬埗 | 璇存槑 |
|---|---|
| Rust 浠ｇ爜淇敼闇€閲嶇紪璇?| `tauri dev` 浼氳嚜鍔ㄨЕ鍙戯紝鐢熶骇鏋勫缓闇€ `tauri build` |
| `shared/types.ts` 涓鸿嚜鍔ㄧ敓鎴?| 鎵嬪姩淇敼浼氳瑕嗙洊锛岀被鍨嬩慨鏀归』鍦?Rust 缁撴瀯浣撲腑杩涜 |
| dockview 鏃犲師鐢?`tabOverflowMode` | 閫氳繃 CSS 瑕嗙洊 `.dv-tabs-container { overflow-x: auto }` 瑙ｅ喅 |
| `api.width = 0` 鍦?fromJSON 鍚庣珛鍗宠皟鐢?| 閫氳繃 `setTimeout(100ms)` 寤惰繜澶圭揣宸︽爮瀹藉害 |
| KanbanBoard 浠?absolute overlay 瀹炵幇 | Kanban/Workspace 鍏变韩 dockview 瀹炰緥锛屽垏鎹㈡椂 dockview 璁句负 `invisible` |

---

## 鍏€佺敤鎴疯嚜瀹氫箟瑙勫垯

### 8.1 鍙傝€冧唬鐮佺洰褰?

`./code-referance` 鐩綍涓嬩负鍚岀被绔炲搧椤圭洰锛屽彲浠ヨ繘琛岄」鐩唬鐮佸弬鑰冨€熼壌銆傚湪瀹炵幇鏂板姛鑳芥垨瑙ｅ喅闂鏃讹紝鍙紭鍏堟煡闃呮鐩綍涓殑鍙傝€冨疄鐜帮紝浜嗚В鍚岀被浜у搧鐨勮璁℃ā寮忓拰瑙ｅ喅鏂规锛屼絾椤荤粨鍚堟湰椤圭洰鏋舵瀯杩涜閫傞厤锛屼笉寰楃洿鎺ュ鍒剁矘璐淬€?
