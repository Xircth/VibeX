# VibeX 椤圭洰鎬荤粨鏂囨。

> 鏇存柊鏃ユ湡锛?026-03-06
> 鍒嗘敮锛歚vk/5468-superpowers-brai`

---

## 涓€銆佹湳璇?鈫?缁勪欢鏄犲皠

鐢ㄦ埛鏃ュ父鍙ｅご鎻忚堪涓庡疄闄呬唬鐮佺粍浠剁殑瀵瑰簲鍏崇郴銆?

### 甯冨眬鍖哄煙鏈

| 鐢ㄦ埛鏈 | 鎶€鏈湳璇?| Group ID | 璇存槑 |
|---|---|---|---|
| **宸︽爮** | Left Sidebar | `GROUP_IDS.LEFT = 'group-left'` | 鏂囦欢鏍?/ Git 闈㈡澘鎵€鍦ㄧ殑宸︿晶鍙敹鎶樹晶杈规爮锛屾棤鏍囩澶达紙`dv-header-hidden`锛?|
| **涓?鏍?* | Center-1 | `GROUP_IDS.CENTER_1 = 'group-center-1'` | 涓荤紪杈戝尯宸﹀崐閮ㄥ垎锛圞anban銆佹杩庨〉銆丏iff銆丳review銆丩ogs銆丯otes 绛夛級 |
| **涓?鏍?* | Center-2 | `GROUP_IDS.CENTER_2 = 'group-center-2'` | 涓荤紪杈戝尯鍙冲崐閮ㄥ垎锛屼笌 Center-1 骞舵帓 |
| **缁堢鏍?* | Bottom Terminal | `GROUP_IDS.BOTTOM = 'group-bottom'` | 搴曢儴缁堢/鏃ュ織闈㈡澘 |
| **鍙虫爮** | Right Fixed Panel | 鈥旓紙涓嶅睘浜?dockview锛?| AI 瀵硅瘽鍖哄煙锛屽浐瀹氬搴︼紙榛樿 500px锛夛紝閫氳繃 `IDELayout.rightPanelContent` 鎻掓Ы浼犲叆锛?*涓嶅彈 dockview 绠＄悊** |
| **娲诲姩鏍?* | Activity Bar | 鈥?| 鏈€宸︿晶鐨勫浘鏍囨爮锛堝 40px锛夛紝鏈夋枃浠舵爲鍜?Git 涓や釜鍥炬爣鎸夐挳 |
| **宸ュ叿鏍?* | Toolbar | 鈥?| 椤堕儴宸ュ叿鏍忥紝鍚?Logo銆佸垎鏀姸鎬併€乀ab 鍒囨崲锛圞anban/Workspace锛夈€侀潰鏉垮垏鎹㈡寜閽粍 |
| **鐘舵€佹爮** | StatusBar | 鈥?| 搴曢儴鐘舵€佹爮 |

### 闈㈡澘 ID 鈫?缁勪欢

| Panel ID | 甯搁噺鍚?| 缁勪欢鏂囦欢 | 榛樿鍖哄煙 | 璇存槑 |
|---|---|---|---|---|
| `kanban` | `PANEL_IDS.KANBAN` | `DockviewKanbanPanel` | Center | Kanban 鐪嬫澘锛堝疄闄呬互鍏ㄥ睆瑕嗙洊灞傛覆鏌擄紝dockview 闈㈡澘浠呭崰浣嶏級 |
| `file-tree` | `PANEL_IDS.FILE_TREE` | `DockviewFileTreePanel` | 宸︽爮 | 鏂囦欢鏍戞祻瑙堝櫒 |
| `git` | `PANEL_IDS.GIT` | `DockviewGitPanel` | 宸︽爮 | Git 鐘舵€?鎿嶄綔绠＄悊鍣?|
| `terminal` | `PANEL_IDS.TERMINAL` | `DockviewTerminalPanel` | 缁堢鏍?| xterm.js + Tauri PTY锛屾敮鎸佸 tab銆乻hell 鍒囨崲 |
| `diffs` | `PANEL_IDS.DIFFS` | `DockviewDiffsReviewPanel` | 涓?/涓? | Diff 瀹℃煡闈㈡澘锛屾敮鎸佷唬鐮佹敞閲娿€佽绾?review |
| `preview` | `PANEL_IDS.PREVIEW` | `DockviewPreviewPanel` | 涓?/涓? | 鍐呭祵 webview 棰勮锛堝紑鍙戞湇鍔″櫒 URL锛?|
| `welcome` | `PANEL_IDS.WELCOME` | `DockviewWelcomePanel` | 涓? | 宸ヤ綔鍖烘杩?绌虹櫧鍗犱綅椤?|
| `logs` | `PANEL_IDS.LOGS` | `DockviewLogsPanel` | 涓?/涓? | 鎵ц鏃ュ織鏌ョ湅鍣?|
| `notes` | `PANEL_IDS.NOTES` | `DockviewNotesPanel` | 涓?/涓? | 宸ヤ綔鍖虹瑪璁?|
| `ai-chat` | `PANEL_IDS.AI_CHAT` | `DockviewAIChatPanel` | 鈥旓紙鍗犱綅锛?| 浠呮敞鍐岀敤锛屽疄闄?AI Chat 鍦ㄥ彸渚у浐瀹氶潰鏉?|

### 鍙虫爮鍐呴儴缁撴瀯

```
鍙虫爮锛圧ightPanelContent锛?
鈹溾攢鈹€ BranchInfoHeader         鈫?鍒嗘敮淇℃伅澶达細褰撳墠鍒嗘敮銆佺洰鏍囧垎鏀€佸垏鎹㈢洰鏍囧垎鏀寜閽?
鈹溾攢鈹€ Outlet锛堣矾鐢卞唴瀹癸級        鈫?鏍规嵁璺敱娓叉煋 TaskPanel / TaskAttemptPanel 绛?
鈹?    鈹溾攢鈹€ TaskPanel          鈫?浠诲姟璇︽儏 + 鍘嗗彶灏濊瘯鍒楄〃
鈹?    鈹斺攢鈹€ TaskAttemptPanel   鈫?瀵硅瘽鍘嗗彶 + TaskFollowUpSection锛堣緭鍏ユ锛?
鈹斺攢鈹€ RightPanelSidebar        鈫?鍙充晶杩蜂綘渚ц竟鏍忥紙瀹￠槄銆佹爣璁扮瓑锛?
```

---

## 浜屻€侀」鐩灦鏋?

### 2.1 鎶€鏈爤鎬昏

```
鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
鈹?             Tauri v2 妗岄潰搴旂敤瀹瑰櫒                    鈹?
鈹?                                                    鈹?
鈹? 鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹? 鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹?
鈹? 鈹?  鍓嶇 (Vite + React) 鈹? 鈹?  鍚庣 (Rust / Tokio) 鈹?鈹?
鈹? 鈹?                     鈹? 鈹?                     鈹?鈹?
鈹? 鈹? React 18 + TS       鈹? 鈹? Tauri Commands      鈹?鈹?
鈹? 鈹? TanStack Query      鈹? 鈹? SQLite (sqlx)       鈹?鈹?
鈹? 鈹? Zustand             鈹? 鈹? Git (git2)          鈹?鈹?
鈹? 鈹? dockview-react      鈹? 鈹? PTY (Terminal)      鈹?鈹?
鈹? 鈹? xterm.js            鈹? 鈹? AI Executors        鈹?鈹?
鈹? 鈹? Monaco Editor       鈹? 鈹? Services Layer      鈹?鈹?
鈹? 鈹? react-router-dom v6 鈹? 鈹? Deployment Mgmt     鈹?鈹?
鈹? 鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹? 鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹?
鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
```

### 2.2 鍓嶇灞傜骇缁撴瀯

```
App.tsx锛堣矾鐢辨牴锛?
鈹斺攢鈹€ IDEWorkspaceRoute         /local-projects/:projectId/tasks/*
      鈹斺攢鈹€ WorkspaceLayout     娉ㄥ叆 Context 灞?
            鈹? providers: WorktreeProvider 鈫?ReviewProvider
            鈹?            鈫?TerminalProvider 鈫?PanelActionsProvider
            鈹斺攢鈹€ IDELayout     dockview 甯冨眬瀹瑰櫒
                  鈹溾攢鈹€ [宸ュ叿鏍廬 Toolbar
                  鈹?    鈹溾攢鈹€ WorktreeSelector锛堝乏锛?
                  鈹?    鈹溾攢鈹€ WorkspaceTabSwitcher锛堜腑锛夆€斺€?Kanban / Workspace
                  鈹?    鈹斺攢鈹€ 闈㈡澘鍒囨崲鎸夐挳缁勶紙鍙筹級
                  鈹溾攢鈹€ [娲诲姩鏍廬 ActivityBar锛堝 40px锛?
                  鈹溾攢鈹€ [涓诲尯鍩焆 DockviewReact锛坉ockview 绠＄悊锛?
                  鈹?    鈹溾攢鈹€ group-left     鈫?FileTree / Git
                  鈹?    鈹溾攢鈹€ group-center-1 鈫?Kanban / Welcome / Diffs / Preview / Logs / Notes
                  鈹?    鈹溾攢鈹€ group-center-2 鈫?锛堝悓涓婏紝骞舵帓锛?
                  鈹?    鈹斺攢鈹€ group-bottom   鈫?Terminal
                  鈹溾攢鈹€ [Kanban瑕嗙洊灞俔 KanbanBoard锛坅ctiveTab=kanban 鏃跺叏灞忔樉绀猴級
                  鈹溾攢鈹€ [鍙充晶鍥哄畾] RightPanelContent
                  鈹?    鈹溾攢鈹€ BranchInfoHeader
                  鈹?    鈹溾攢鈹€ Outlet锛圱askPanel / TaskAttemptPanel锛?
                  鈹?    鈹斺攢鈹€ RightPanelSidebar
                  鈹斺攢鈹€ [鐘舵€佹爮] StatusBar
```

### 2.3 鍚庣 Crate 鏋舵瀯

```
src-tauri/锛圱auri 鍏ュ彛锛岀粍瑁?Tauri Commands锛?
鈹?
鈹溾攢鈹€ crates/db/              鏁版嵁搴撳眰锛歋QLite schema銆乵igrations銆丆RUD
鈹溾攢鈹€ crates/services/        涓氬姟閫昏緫灞傦細浠诲姟銆佷細璇濄€乨iff娴併€乹ueue銆乻cratch
鈹溾攢鈹€ crates/git/             Git 鎿嶄綔锛歞iff 鐢熸垚銆乥ranch銆亀orktree銆乺ebase
鈹溾攢鈹€ crates/executors/       AI 鎵ц鍣細Claude Code 绛?agent 鐨勬娊璞″拰瀹炵幇
鈹溾攢鈹€ crates/deployment/      閮ㄧ讲绠＄悊锛欰ppState 鍒濆鍖栥€佷簨浠惰浆鍙?
鈹溾攢鈹€ crates/local-deployment/鏈湴閮ㄧ讲瀹炵幇
鈹溾攢鈹€ crates/api-types/       鍏变韩 API 绫诲瀷锛圱S 绫诲瀷閫氳繃 ts-rs 鐢熸垚锛?
鈹溾攢鈹€ crates/utils/           宸ュ叿鍑芥暟锛歞iff 璁＄畻銆佽祫婧愯矾寰勭瓑
鈹斺攢鈹€ crates/review/          锛堢嫭绔?binary锛屼笉琚富 crate 寮曠敤锛?
```

### 2.4 鏁版嵁娴?

```
鐢ㄦ埛鎿嶄綔锛堝墠绔級
    鈹?
    鈻?
tauriInvoke('command_name', args)     鈫?鍓嶇璋冪敤 Tauri 鍛戒护
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
Tauri Events锛圫SE-like锛?             鈫?娴佸紡鎺ㄩ€侊紙diff stream, conversation stream锛?
    鈹?
    鈻?
鍓嶇 useQuery / EventSource 璁㈤槄
```

### 2.5 甯冨眬鎸佷箙鍖栨満鍒?

- **瀛樺偍**锛歚localStorage` key `vibex-ide-layout`锛堢増鏈?8锛?
- **绠＄悊**锛歓ustand + `persist` 涓棿浠讹紙`useLayoutStore`锛?
- **搴忓垪鍖?*锛歚api.toJSON()` / `api.fromJSON()`锛坉ockview 鍐呯疆锛?
- **鎭㈠娴佺▼**锛?
  1. `handleReady` 璇诲彇 `serializedLayout`
  2. `api.fromJSON(layout)` 鎭㈠
  3. `applyLeftGroupHeaderHiding` 閲嶆柊闅愯棌宸︽爮澶撮儴
  4. `validateTerminalPosition` 妫€鏌ョ粓绔槸鍚﹁鍏ュ乏鏍?
  5. `setTimeout(100ms)` 寤惰繜澶圭揣宸︽爮瀹藉害锛堢瓑寰?DOM 鐪熷疄灏哄锛?

### 2.6 AI 杈撳叆妗嗙粍浠跺眰娆?

```
TaskFollowUpSection锛堜富杈撳叆鍖猴級
鈹溾攢鈹€ WYSIWYGEditor               瀵屾枃鏈緭鍏?
鈹溾攢鈹€ PermissionSelector          鏉冮檺妯″紡锛氳嚜鍔?/ 璇㈤棶 / 璁″垝
鈹溾攢鈹€ ModelSelector               妯″瀷閫夋嫨锛氶粯璁?/ Opus
鈹溾攢鈹€ PluginSelector              鎻掍欢閫夋嫨锛堣鍙?~/.claude/settings.json enabledPlugins锛?
鈹溾攢鈹€ Attachment / ReviewChanges  闄勪欢 & 瀹￠槄鎸夐挳
鈹斺攢鈹€ Send / Stop / Queue         鍙戦€?/ 鍋滄 / 鎺掗槦鎸夐挳

RetryEditorInline锛堥噸璇曠紪杈戝櫒锛?
鈹斺攢鈹€ 鍚屼笂涓夐€夋嫨鍣紙鏉冮檺 / 妯″瀷 / 鎻掍欢锛?

TaskFormDialog / CreateAttemptDialog锛堝垱寤轰换鍔?灏濊瘯瀵硅瘽妗嗭級
鈹斺攢鈹€ AgentSelector + PermissionSelector + ModelSelector + PluginSelector
```

### 2.7 閰嶇疆鏂囦欢

| 鏂囦欢 | 璇存槑 |
|---|---|
| `~/.claude/settings.json` | Claude Code 璁剧疆锛歟nv 鍙橀噺銆乪nabledPlugins銆乸ermissions |
| `~/.vibex/config.json` | VibeX 搴旂敤閰嶇疆 |
| `~/.vibex/profiles.json` | AI 鎵ц鍣?profiles 閰嶇疆 |
| `~/.vibex/vibex.db` | SQLite 鏁版嵁搴?|

---

## 涓夈€佸凡鐭ラ棶棰樻竻鍗?

### 3.1 宸蹭慨澶嶇殑 Bug锛堟湰鍒嗘敮 batch 9鈥?1锛?

| # | 闂鎻忚堪 | 淇鏂瑰紡 | 鎻愪氦 |
|---|---|---|---|
| B1 | `enabledPlugins` 瀛楁琚В鏋愪负 `Vec<String>` 瀵艰嚧鏃犳硶璇诲彇 `{"plugin": true}` 鏍煎紡 | Rust 鏀逛负 `HashMap<String, bool>` + `Value` 瑙ｆ瀽 | `893c7c1`, `9fa01f5` |
| B2 | 宸︿晶闈㈡澘瀹藉害鏃犻檺鍒讹紝缁堢鎷栨嫿鏃朵镜鍏ュ乏鏍?| `onDidLayoutChange` 涓す绱у乏鏍忓搴?鈮?40% | `dee9620` |
| B3 | 鍒濆鍖栨椂缁堢渚靛叆宸︽爮锛坒romJSON 鍚屾锛孌OM 寮傛锛宎pi.width=0锛?| `setTimeout(100ms)` 寤惰繜澶圭揣 | `9fa01f5` |
| B4 | 鏍囩椤垫孩鍑烘棤娉曟í鍚戞粴鍔紝鍙兘鐢ㄥ彸渚т笅鎷?| CSS 瑕嗙洊 `.dv-tabs-container { overflow-x: auto }` | `9fa01f5` |
| B5 | 榛樿鏉冮檺涓?`ask`锛堣闂級锛屽簲涓?`auto`锛堣嚜鍔級 | 4 涓粍浠剁殑 `useState` 鍒濆鍊兼敼涓?`'auto'` | `9fa01f5` |
| B6 | `BranchInfoHeader` "鍒囨崲鐩爣鍒嗘敮" 鎸夐挳鏃犳晥锛堢┖鍑芥暟锛?| 瀹炵幇 `handleChangeTarget`锛屾帴鍏?`ChangeTargetBranchDialog` | `c650d89` |
| B7 | `RetryEditorInline` 浣跨敤鏃х殑 `VariantSelector` | 鏇挎崲涓?`PermissionSelector + ModelSelector + PluginSelector` | `c650d89` |
| B8 | `TaskFormDialog`/`CreateAttemptDialog` 浣跨敤鏃х殑 `ExecutorProfileSelector` | 鍚屼笂涓夐€夋嫨鍣ㄦ浛鎹?| `c650d89` |
| B9 | `UserMessage` 鏃犲洖閫€鎸夐挳锛坄sessionsApi.reset` 宸插疄鐜颁絾鏈繛鎺?UI锛?| 娣诲姞鎮诞 Undo 鎸夐挳 + `RestoreLogsDialog` | `c650d89` |
| B10 | 缁堢鍐呭涓庡乏杈圭紭绱ц创锛屾棤鍐呰竟璺?| `px-2 pt-1` padding 鍔犲埌缁堢瀹瑰櫒 | `00bdf0b` |
| B11 | Diff 棰勮鏄剧ず "Content omitted due to file size." 鏃犳硶棰勮 | 娣诲姞"鍔犺浇棰勮"鎸夐挳锛屾寜闇€璇诲彇 HEAD 鍐呭 + 宸ヤ綔鍖哄唴瀹?| `00bdf0b` |
| B12 | PluginSelector Tauri 浜岃繘鍒舵湭閲嶆柊缂栬瘧鏃惰繑鍥炵┖鎻掍欢 | `useClaudeSettings` 澧炲姞鏂囦欢绯荤粺 fallback锛岀洿鎺ヨВ鏋?`settings.json` | `00bdf0b` |
| B13 | Diff "鍔犺浇棰勮"鍚庢樉绀?+0 -0锛坢odified 鏂囦欢 oldPath=null锛孒EAD 璺緞閿欒锛?| 鏀逛负 `headRelPath = diff.oldPath \|\| diff.newPath`锛屼慨澶?`useMemo` 渚濊禆 | `04a3686` |

### 3.2 宸茬煡鏋舵瀯闄愬埗

| # | 闂 | 褰卞搷 | 璇存槑 |
|---|---|---|---|
| A1 | **Tauri 浜岃繘鍒堕渶鎵嬪姩閲嶆柊缂栬瘧** | Rust 浠ｇ爜淇敼鍚庯紝`tauri dev` 浼氳嚜鍔ㄨЕ鍙戯紝浣?production build 闇€瑕?`tauri build` | Rust 涓嶅儚鍓嶇鍙互鐑噸杞?|
| A2 | **PluginSelector 浠呮洿鏂版湰鍦?UI 鐘舵€?* | 閫夋嫨鎻掍欢鍚庡疄闄呮棤娉曟帶鍒?Claude Code 浣跨敤鍝釜鎻掍欢锛堟彃浠剁敱 `settings.json` 鍏ㄥ眬鎺у埗锛?| 闇€瑕?follow_up API 鏀寔 plugin 瀛楁鎵嶈兘瀹炵幇 per-message 鎻掍欢閫夋嫨 |
| A3 | **dockview 鏃?`tabOverflowMode` API锛坴5.1.0锛?* | 鏃犳硶鍘熺敓閰嶇疆鏍囩婧㈠嚭琛屼负 | 閫氳繃 CSS 瑕嗙洊 `overflow-x: auto` 鍙橀€氳В鍐?|
| A4 | **`api.width = 0` 鍦?fromJSON 鍚庣珛鍗宠皟鐢?* | 宸︽爮瀹藉害澶圭揣鍦ㄥ垵濮嬪寲鏃跺け鏁?| 閫氳繃 `setTimeout(100ms)` 缁曡繃 |
| A5 | **`KanbanBoard` 浠?absolute overlay 瀹炵幇** | Kanban 鍜?Workspace 涓や釜 Tab 鍏变韩 dockview 瀹炰緥锛孠anban 婵€娲绘椂 dockview 璁句负 `invisible` | 鍒囨崲 Tab 鏃跺竷灞€鐘舵€佸緱浠ヤ繚鐣欙紝浣嗗唴瀛樺崰鐢ㄧ暐楂?|
| A6 | **`shared/types.ts` 鐢?Rust 鑷姩鐢熸垚** | 鎵嬪姩淇敼 `shared/types.ts` 浼氳 `generate-types` 鑴氭湰瑕嗙洊 | 绫诲瀷淇敼闇€鍦?Rust 缁撴瀯浣撲腑杩涜 |

### 3.3 寰呬紭鍖栭」

| # | 浼樺寲鐐?| 浼樺厛绾?|
|---|---|---|
| O1 | `useClaudeSettings` fallback 璺緞鍦?`enabled_plugins` 涓虹┖鏃跺缁堣Е鍙戯紙鏃犳硶鍖哄垎"鐪熸涓虹┖"鍜?浜岃繘鍒舵湭閲嶇紪璇?锛?| 涓?|
| O2 | `DiffCard` 鐨?鍔犺浇棰勮"姣忔閮介噸鏂板姞杞斤紝鏃犵紦瀛?| 浣?|
| O3 | `validateTerminalPosition` 鍙鏌?`group.id === GROUP_IDS.LEFT`锛屾棤娉曞鐞嗙粓绔湪瑙嗚涓婃孩鍑猴紙瀹藉害寮傚父锛夌殑鎯呭喌 | 浣?|
| O4 | 鍙充晶闈㈡澘瀹藉害闄愬埗锛堟渶灏?480px锛夊湪灏忓睆骞曚笂鍙兘瀵艰嚧甯冨眬鍘嬬缉 | 浣?|
| O5 | `TaskFollowUpSection` 搴曢儴鎸夐挳鏍忓湪灏忕獥鍙ｄ笅 flex-wrap 浼氭崲琛岋紝褰卞搷瑙嗚 | 浣?|

---

## 鍥涖€佸叧閿枃浠堕€熸煡

```
frontend/src/
鈹溾攢鈹€ App.tsx                              璺敱鏍?
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
鈹?  鈹?  鈹溾攢鈹€ DockviewDiffsReviewPanel.tsx Diff 瀹℃煡闈㈡澘
鈹?  鈹?  鈹斺攢鈹€ ...
鈹?  鈹溾攢鈹€ tasks/
鈹?  鈹?  鈹溾攢鈹€ PermissionSelector.tsx       鏉冮檺閫夋嫨鍣?
鈹?  鈹?  鈹溾攢鈹€ ModelSelector.tsx            妯″瀷閫夋嫨鍣?
鈹?  鈹?  鈹溾攢鈹€ PluginSelector.tsx           鎻掍欢閫夋嫨鍣?
鈹?  鈹?  鈹斺攢鈹€ TaskFollowUpSection.tsx      涓昏緭鍏ュ尯
鈹?  鈹斺攢鈹€ NormalizedConversation/
鈹?      鈹溾攢鈹€ RetryEditorInline.tsx        閲嶈瘯缂栬緫鍣?
鈹?      鈹斺攢鈹€ UserMessage.tsx              鐢ㄦ埛娑堟伅锛堝惈鍥為€€鎸夐挳锛?
鈹溾攢鈹€ stores/
鈹?  鈹斺攢鈹€ useLayoutStore.ts                甯冨眬鐘舵€侊紙Zustand + persist锛?
鈹溾攢鈹€ hooks/
鈹?  鈹斺攢鈹€ useClaudeSettings.ts             璇诲彇 ~/.claude/settings.json
鈹斺攢鈹€ lib/
    鈹斺攢鈹€ api.ts                           鎵€鏈?Tauri IPC 璋冪敤灏佽

src-tauri/src/commands/
鈹溾攢鈹€ config.rs                            get/update_claude_settings
鈹溾攢鈹€ file_tree.rs                         read_file_content, get_file_at_head,
鈹?                                       get_claude_settings_path
鈹溾攢鈹€ sessions.rs                          follow_up, reset_session_process
鈹斺攢鈹€ workspaces.rs                        branch/git/merge/rebase 鎿嶄綔

shared/types.ts                          鑷姩鐢熸垚鐨?TS 绫诲瀷锛堝嬁鎵嬪姩淇敼锛?
```
