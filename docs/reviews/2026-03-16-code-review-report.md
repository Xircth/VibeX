# VibeX 浠ｇ爜瀹℃煡鎶ュ憡

> 瀹℃煡鏃ユ湡: 2026-03-16 (绗簩杞?
> 瀹℃煡鑼冨洿: 鍏ㄩ」鐩唬鐮侊紙鍓嶇 + Rust 鍚庣锛?
> 鎬讳綋璇勭骇: **璀﹀憡** -- 鏃犻樆濉炴€ч棶棰橈紝瀛樺湪 2 涓叧閿畨鍏ㄦ紡娲炲拰澶氫釜楂樹紭鍏堢骇浜嬮」

---

## 涓€銆佸畨鍏ㄥ垎鏋?

### 1.1 鍏抽敭瀹夊叏闂

#### [P0] file_tree 鍛戒护鏃犺矾寰勯亶鍘嗛槻鎶?

**鏂囦欢**: `src-tauri/src/commands/file_tree.rs:415-452`

`read_file_content`銆乣save_file_content`銆乣delete_file` 鎺ュ彈鍓嶇浼犲叆鐨勪换鎰忔枃浠惰矾寰勶紝鏃犳矙鐩掓鏌ャ€俙delete_file` 鏀寔 `remove_dir_all`锛屽彲閫掑綊鍒犻櫎鏁翠釜鐩綍鏍戙€傚悓鏍烽棶棰樺瓨鍦ㄤ簬 `trash_item`(801)銆乣copy_item`(814)銆乣create_directory`(894)銆?

**淇**: 楠岃瘉鎵€鏈夎矾寰勫繀椤讳綅浜庡凡娉ㄥ唽鐨勪粨搴撴牴鐩綍鎴栧伐浣滃尯鐩綍涓嬶紱瑙勮寖鍖栬矾寰勫悗妫€鏌ュ墠缂€锛涙嫆缁?`..` 缁勪欢銆?

### 1.2 楂樺畨鍏ㄩ棶棰?

#### [P1] PowerShell 鍛戒护娉ㄥ叆 -- open_browser

**鏂囦欢**: `crates/utils/src/browser.rs:8-9`

```rust
cmd.arg("-Command").arg(format!("Start-Process '{url}'"));
```

URL 涓殑鍗曞紩鍙峰彲閫冮€稿苟鎵ц浠绘剰 PowerShell 鍛戒护銆?

**淇**: 瀵瑰崟寮曞彿杞箟锛坄''`锛夛紝鎴栨敼鐢?`Start-Process -Uri` 鍙傛暟鍖栦紶閫掋€?

#### [P1] PowerShell 鍛戒护娉ㄥ叆 -- notification sound

**鏂囦欢**: `crates/services/src/services/notification.rs:90-91`

```rust
.arg(format!(r#"(New-Object Media.SoundPlayer "{file_path}").PlaySync()"#))
```

鍙屽紩鍙锋垨 `$()` 瀛愯〃杈惧紡鍙Е鍙戝懡浠ゆ敞鍏ャ€?

#### [P1] osascript 鍛戒护娉ㄥ叆 -- macOS 閫氱煡

**鏂囦欢**: `crates/services/src/services/notification.rs:111-120`

铏界劧瀵瑰弻寮曞彿鍋氫簡杞箟锛屼絾 AppleScript 瀛樺湪鍏朵粬娉ㄥ叆鍚戦噺銆俙message` 鍜?`title` 鏉ユ簮浜庣敤鎴疯緭鍏ョ殑浠诲姟鏍囬銆?

**淇**: 鏀圭敤 `notify-rust` crate锛堝凡鍦?Linux 鐗堟湰浣跨敤锛夈€?

#### [P1] ensure_aimax_installed 鏂囦欢鍚嶆湭楠岃瘉

**鏂囦欢**: `src-tauri/src/commands/skills.rs:206-218`

`filename` 浠?JSON 涓鍙栧悗鐩存帴鎷兼帴璺緞锛屾湭鍋氶獙璇併€傚綋鍓嶆暟鎹潵鑷紪璇戞椂宓屽叆鐨勫彲淇?JSON锛屼絾濡傛灉鏈潵鍙樻洿涓哄姩鎬佸姞杞藉垯鏈夐闄┿€?

### 1.3 涓畨鍏ㄩ棶棰?

| 闂 | 鏂囦欢 | 璇存槑 |
|------|------|------|
| Preview Proxy SSRF | `src-tauri/preview_proxy.rs:55-89` | 鍙闂湰鏈轰换浣曟湇鍔★紱`0.0.0.0` 鍙兘璺敱鍒板閮?|
| ReDoS 姝ｅ垯琛ㄨ揪寮忔嫆缁濇湇鍔?| `src-tauri/commands/file_tree.rs:290-304` | 鐢ㄦ埛杈撳叆鐩存帴缂栬瘧涓烘鍒?|
| Auth 閰嶇疆鏄庢枃浼犺緭 | `src-tauri/commands/config.rs:519-636` | API Key 閫氳繃 IPC 鏄庢枃浼犵粰鍓嶇 |
| 鑴氭湰鎵ц鐢ㄦ埛 shell 鍛戒护 | `crates/executors/src/actions/script.rs:56-65` | 璁捐濡傛锛屼絾闇€纭繚鏉ユ簮鍙俊 |

### 1.4 鑹ソ瀹夊叏瀹炶返

- Git CLI 浣跨敤 `Command::new().arg()` 瀹夊叏鍙傛暟浼犻€掞紝閬垮厤 shell 娉ㄥ叆
- SQL 鍏ㄩ儴浣跨敤 `sqlx::query!` 鍙傛暟鍖栨煡璇紝缂栬瘧鏃舵鏌?
- XSS 闃叉姢浣跨敤 **DOMPurify**锛坄syntax.ts:41-45`锛夛紝閰嶇疆涓轰粎鍏佽 `<span>` 鍜?`class`
- `validate_skill_key` 姝ｇ‘鏍￠獙 skill key 鍙厑璁稿瓧姣嶆暟瀛楀拰 `-`銆乣_`
- `list_directory_children` 妫€鏌ヨ矾寰勭粍浠堕槻姝㈤亶鍘嗭紙`file_tree.rs:529-535`锛?
- 澶栭儴閾炬帴鏅亶浣跨敤 `rel="noopener noreferrer"`
- `sanitizeHref` 闃绘 `javascript:`/`vbscript:`/`data:` 鍗忚
- localStorage 浠呭瓨鍌?UI 鐘舵€侊紝涓嶅瓨鍌ㄦ晱鎰熶俊鎭?
- OpenCode 瀵嗙爜浣跨敤鍔犲瘑闅忔満鐢熸垚

---

## 浜屻€佹€ц兘鍒嗘瀽

### 2.1 鍏抽敭鎬ц兘闂

#### [P0] 鏂囦欢鏍戞湭浣跨敤铏氭嫙婊氬姩

**鏂囦欢**: `frontend/src/components/file-tree/FileTreePanel.tsx` (1359 琛?

鐩存帴閫掑綊娓叉煋鎵€鏈夋枃浠惰妭鐐瑰埌 DOM銆傚ぇ鍨嬩粨搴擄紙5000+ 鏂囦欢锛夐娆℃覆鏌?500ms+ 鍗￠】銆?

**淇**: 浣跨敤 react-virtuoso锛堝凡瀹夎锛夋墎骞冲寲涓鸿櫄鎷熸粴鍔ㄥ垪琛紝閫氳繃缂╄繘妯℃嫙鏍戠粨鏋勩€?

#### [P0] 瀵硅瘽鍘嗗彶鍒楄〃鏈娇鐢ㄨ櫄鎷熸粴鍔?

**鏂囦欢**: `frontend/src/components/NormalizedConversation/DisplayConversationEntry.tsx` (1205 琛?

闀挎椂闂?AI 浼氳瘽浜х敓鏁扮櫨鏉″璇濇潯鐩紝姣忔潯鍖呭惈澶嶆潅瀛愮粍浠讹紙浠ｇ爜鍧椼€乨iff銆丮arkdown锛夛紝鍏ㄩ噺娓叉煋銆?

**淇**: 浣跨敤 react-virtuoso 鐨勫姩鎬侀珮搴﹁櫄鎷熷寲銆?

#### [P0] claude.rs 鐑矾寰勮繃搴?clone

**鏂囦欢**: `crates/executors/src/executors/claude.rs` (2723 琛? 78 涓?`.clone()`)

娑堟伅娴佸鐞嗗惊鐜腑瀵瑰ぇ瀛楃涓茬殑涓嶅繀瑕?clone锛?
- 731-732: `old_string.clone().unwrap_or_default()` -> 鐢?`as_deref().unwrap_or("")`
- 593-597: `session_id.clone()` 鍦ㄦ瘡涓?match 鍒嗘敮閲嶅
- 664-668: `text.clone()` 杩炵画涓ゆ clone 鍚屼竴鍊?

### 2.2 楂樻€ц兘闂

| 闂 | 鏂囦欢 | 璇存槑 |
|------|------|------|
| N+1 鏌ヨ: agent_setting reorder | `crates/db/src/models/agent_setting.rs:92` | 寰幆涓€愭潯 UPDATE |
| N+1 鏌ヨ: image associate_many_dedup | `crates/db/src/models/image.rs:186` | 寰幆涓€愭潯 INSERT锛屾棤浜嬪姟 |
| scroll 浜嬩欢鏃犺妭娴?| `frontend/src/components/panels/git/GitDiffViewer.tsx:83-103` | 姣忔婊氬姩閬嶅巻鎵€鏈?diff card + getBoundingClientRect |
| localStorage 搴忓垪鍖栭鐜囪繃楂?| `frontend/src/components/layout/IDELayout.tsx:720-737` | 100ms 闃叉姈鍋忕煭锛宼oJSON + setItem 鍚屾闃诲 |
| Rust git/lib.rs 2776 琛?| `crates/git/src/lib.rs` | 澧炲姞缂栬瘧鏃堕棿锛屾ā鍧楅棿鍑芥暟鏃犳硶鍐呰仈浼樺寲 |

### 2.3 涓€ц兘闂

| 闂 | 鏂囦欢 | 璇存槑 |
|------|------|------|
| TerminalContext 骞挎挱閲嶆覆鏌?| `frontend/src/contexts/TerminalContext.tsx:206-228` | state 鍙樺寲瀵艰嚧鎵€鏈?consumer 閲嶈幏鍙?callback |
| LoadingCard 姣忕 setState | `DisplayConversationEntry.tsx:754-763` | setInterval 姣忕鏇存柊 elapsed |
| 寮傛鎿嶄綔缂哄皯骞惰鍖?| Rust 鍚庣鏁翠綋 | 浠?2 澶?`join_all`/`tokio::join!`锛屽ぇ閲忎覆琛?await |
| 鎴愬姛鎻愮ず setTimeout 閲嶅妯″紡 | `GitOperations.tsx` 绛?10+ 澶?| 搴旀彁鍙?`useTemporaryFlag(duration)` hook |

### 2.4 鑹ソ鎬ц兘瀹炶返

- **PanelActionsContext 浣跨敤 useRef 閬垮厤閲嶆覆鏌?*锛坄PanelActionsContext.tsx:84`锛?- 鍥炶皟閫氳繃 ref 璁块棶 API
- **Context value 鍏ㄩ儴 useMemo 鍖呰９** -- 闃叉瀛愭爲閲嶆覆鏌?
- **Git Log 浣跨敤铏氭嫙婊氬姩**锛坄GitLogView.tsx:586`锛?- react-virtuoso
- **scroll 鐩戝惉浣跨敤 passive**锛坄GitDiffViewer.tsx:102`锛?
- **DockviewDiffsReviewPanel 浣跨敤 IntersectionObserver** 鏇夸唬 scroll 浜嬩欢
- **console.log 闆舵畫鐣?* -- 浠ｇ爜娓呮磥搴﹁壇濂?
- **鍏ㄩ」鐩?710 澶?useMemo/useCallback**锛?48 涓枃浠讹級-- 鍥㈤槦鎬ц兘鎰忚瘑濂?
- **workspace_repo 鎵归噺鎻掑叆浣跨敤浜嬪姟**锛坄workspace_repo.rs:59`锛?
- **Zustand persist 浣跨敤 partialize** -- 鍙寔涔呭寲蹇呰瀛楁
- **Markdown 娓叉煋 80ms 鑺傛祦** -- 閬垮厤娴佸紡鏇存柊鎬ц兘闂
- **澶?diff 鍜屽垹闄ゆ枃浠惰嚜鍔ㄦ姌鍙?* -- 鍑忓皯娓叉煋璐熸媴

---

## 涓夈€佷唬鐮佽川閲忓垎鏋?

### 3.1 瓒呭ぇ鏂囦欢

**涓ラ噸瓒呮爣 (>1000 琛?:**

| 鏂囦欢 | 琛屾暟 | 绫诲瀷 | 寤鸿 |
|------|------|------|------|
| `crates/git/src/lib.rs` | 2776 | Rust | 鎸夊姛鑳芥媶鍒嗕负 `diff.rs`銆乣branch.rs`銆乣worktree.rs`銆乣log.rs` |
| `crates/executors/src/executors/claude.rs` | 2723 | Rust | 鎷嗗垎 `normalize.rs`銆乣protocol.rs`銆佹祴璇曠Щ鑷?`tests/` |
| `crates/local-deployment/src/container.rs` | 1467 | Rust | 鎷嗗垎 `container_lifecycle.rs`銆乣container_config.rs` |
| `crates/executors/src/executors/opencode/sdk.rs` | 1463 | Rust | 鎷嗗垎 SDK 杩炴帴灞傚拰娑堟伅澶勭悊灞?|
| `crates/services/src/services/container.rs` | 1426 | Rust | 鎷嗗垎鏈嶅姟娉ㄥ唽涓庢湇鍔＄紪鎺?|
| `crates/executors/src/executors/codex/normalize_logs.rs` | 1268 | Rust | 鐘舵€佹満澶勭悊鎷嗗垎涓哄瓙妯″潡 |
| `crates/git/src/cli.rs` | 1263 | Rust | 鎸?Git 瀛愬懡浠ゆ媶鍒?|
| `frontend/src/utils/icons.ts` | 1369 | TS | 鏁版嵁鏂囦欢锛屽彲鎸夌被鍒媶鍒?|
| `frontend/src/lib/api.ts` | 1367 | TS | 鎸夐鍩熸媶鍒?`api/git.ts`銆乣api/tasks.ts` 绛?|
| `frontend/src/components/file-tree/FileTreePanel.tsx` | 1359 | TSX | 鎷嗗垎瀛愮粍浠跺拰 hooks |
| `frontend/src/components/NormalizedConversation/DisplayConversationEntry.tsx` | 1205 | TSX | 鎸?entry 绫诲瀷鎷嗗垎 |

**瓒呮爣 (800-1000 琛?:**

| 鏂囦欢 | 琛屾暟 | 寤鸿 |
|------|------|------|
| `IDELayout.tsx` | 971 | 鎷嗗垎 hook 鍜屽竷灞€鏋勫缓閫昏緫 |
| `AgentCard.tsx` | 864 | 鎷嗗垎琛ㄥ崟瀛愮粍浠?|
| `useUiPreferencesStore.ts` | 845 | 鎸夊姛鑳藉煙鎷嗗垎 store |

### 3.2 鍏抽敭浠ｇ爜璐ㄩ噺闂

#### [鍏抽敭] 101 澶勭┖ catch 鍧?

閿欒琚潤榛樺悶鎺夛紝鐢ㄦ埛鏃犳硶鎰熺煡鎿嶄綔澶辫触銆傚垎甯冿細
- `IDELayout.tsx`: 12 澶勶紙dockview 鎿嶄綔闃插尽鎬х紪绋嬶級
- `FileTreePanel.tsx`: 6 澶勶紙鏂囦欢鎿嶄綔闈欓粯澶辫触锛?
- `BranchInfoHeader.tsx`: 3 澶?
- 鍏朵粬绾?80 澶?

#### [鍏抽敭] Rust 鐢熶骇浠ｇ爜 7+ 澶?unwrap()

| 鏂囦欢 | 琛屽彿 | 椋庨櫓 |
|------|------|------|
| `claude/protocol.rs` | 127 | `serde_json::to_value(result).unwrap()` -- 搴忓垪鍖栧け璐?panic |
| `codex/normalize_logs.rs` | 253, 255 | `entry.as_ref().unwrap()` -- None panic |
| `codex/normalize_logs.rs` | 602, 716, 840, 884 | `get_mut(&call_id).unwrap()` -- key 涓嶅瓨鍦?panic |
| `opencode/models.rs` | 43, 65 | `lock().unwrap()` -- Mutex 涓瘨 panic |

### 3.3 TypeScript 绫诲瀷瀹夊叏

- `as any`: 浠?1 澶勶紙`dockviewHelpers.ts:23`锛?
- `@ts-expect-error`: 浠?1 澶勶紙`ProjectDetail.tsx`锛?
- 鏁翠綋绫诲瀷绾緥 **鑹ソ**

### 3.4 console 璇彞

- `console.log`: **闆舵畫鐣?*
- `console.error`: ~70 澶? `console.warn`: ~12 澶? `console.debug`: ~6 澶?
- 鎬昏 88 澶勶紝鍒嗗竷鍦?55 涓枃浠朵腑
- **寤鸿**: 寮曞叆缁熶竴 logger 宸ュ叿

### 3.5 纭紪鐮佸€?

- `IDELayout.tsx` 涓?`220` 鍑虹幇 3 娆★紙宸︽爮瀹藉害锛夈€乣200`锛堟渶灏忓搴︼級銆乣100`锛堝欢杩?ms锛?
- **寤鸿**: 鎻愬彇涓?`LAYOUT.LEFT_PANEL_DEFAULT_WIDTH` 绛夊父閲?

### 3.6 閿欒澶勭悊

- `useGitCommit.ts`: `pushError` 璇箟娣蜂贡锛圥ull/Fetch 閿欒涔熷瓨鍏?pushError锛?
- `AgentCard.tsx:328`: `// TODO: toast error` -- 鍗犱綅绗︽湭瀹屾垚
- 澶氬 Git 鎿嶄綔鐨勯敊璇彧瀛樺湪 hook 鍐呴儴 state锛?*鏈悜鐢ㄦ埛灞曠ず toast/閫氱煡**

### 3.7 #[allow(dead_code)]

11 澶?`allow(dead_code)` / `allow(unused)` -- 搴斿鏌ユ槸鍚︿负鐪熸闇€瑕佹竻鐞嗙殑姝讳唬鐮併€?

---

## 鍥涖€佷緷璧栧啑浣欏垎鏋?

### 4.1 鍓嶇 -- 闆朵娇鐢?鍙Щ闄や緷璧?

| 渚濊禆 | 璇存槑 | 棰勪及鑺傜渷 |
|------|------|----------|
| `@ibm/plex` (devDep) | 瀛椾綋宸叉湰鍦板寲涓?woff2锛宯pm 鍖呯函鍐椾綑 | **~30MB node_modules** |
| `@tauri-apps/plugin-shell` | 鍓嶇闆跺鍏ワ紝鍙兘浠?Rust 渚т娇鐢?| ~15KB |
| `@tailwindcss/container-queries` | Tailwind 閰嶇疆涓敞鍐屼絾闆?`@container` 浣跨敤 | 鏋佸皬 |

### 4.2 鍓嶇 -- 鍔熻兘閲嶅彔渚濊禆缁?

| 閲嶅彔缁?| 璇︽儏 | 寤鸿 |
|--------|------|------|
| **鍥炬爣搴?* | `lucide-react`(134澶? + `@phosphor-icons/react`(4澶? + `developer-icons`(1澶? | 缁熶竴鍒?lucide锛岃妭鐪?~500KB+ |
| **浠ｇ爜缂栬緫鍣?* | `@uiw/react-codemirror` + 4涓?`@codemirror/*`(浠?鏂囦欢) + `monaco-editor`(2鏂囦欢) + `prismjs`(1鏂囦欢) | 绉婚櫎 CodeMirror 鍏ㄥ锛岀敤 Monaco 鏇夸唬 JSON 缂栬緫鍣紝鑺傜渷 ~300KB |
| **Diff 娓叉煋** | `@git-diff-view/react`(3鏂囦欢) + `@pierre/diffs`(1鏂囦欢) + Monaco diff | 璇勪及鍚堝苟 |
| **dockview** | `dockview`(1澶? + `dockview-core`(1澶? + `dockview-react`(16澶? | 妫€鏌?re-export 鍙惁绉婚櫎鍓嶄袱鑰?|

### 4.3 鍓嶇 -- 浣跨敤鏋佸皯鐨勪緷璧?

| 渚濊禆 | 浣跨敤 | 鏇夸唬鏂规 |
|------|------|----------|
| `framer-motion` | 3 澶?| CSS transitions/animations锛岃妭鐪?~150KB |
| `@tanstack/react-form` | 1 澶?| 绠€鍗?useState 绠＄悊 |
| `react-resizable-panels` | 1 澶?| 椤圭洰涓诲竷灞€鐢?dockview |
| `embla-carousel-react` | 1 澶?| CSS scroll-snap |
| `react-dropzone` | 1 澶?| HTML5 鍘熺敓 drag & drop |

### 4.4 鍓嶇 -- 鍒嗙被閿欒

| 渚濊禆 | 褰撳墠 | 姝ｇ‘ |
|------|------|------|
| `@rjsf/core`, `@rjsf/utils`, `@rjsf/validator-ajv8` | devDependencies | **dependencies**锛?0 涓繍琛屾椂鏂囦欢瀵煎叆锛?|
| `tailwind-scrollbar`, `tailwindcss-animate` | dependencies | **devDependencies** |

### 4.5 Rust -- 搴旀彁鍗囦负 workspace 渚濊禆

| Crate | 鍑虹幇娆℃暟 |
|-------|---------|
| `sqlx` | **7 澶?*锛坒eatures 涓嶄竴鑷达紝鍏抽敭闂锛?|
| `tokio-util` | 4 澶?|
| `tokio-stream` | 3 澶?|
| `dirs` | 6 澶?|
| `command-group` | 3 澶?|
| `strum`/`strum_macros` | 3 澶?|
| `enum_dispatch` | 2 澶?|
| `base64`, `ignore`, `which`, `toml`, `shlex`, `rust-embed` | 鍚?2 澶?|

### 4.6 Rust -- 鍔熻兘閲嶅彔

- `dirs`(workspace) + `directories`(utils) + `xdg`(executors) -- 涓変釜鐩綍璺緞搴撳叡瀛?
- 寤鸿缁熶竴涓?`dirs` 鎴?`directories` 涔嬩竴

### 4.7 棰勪及鎬绘敹鐩?

| 鎿嶄綔 | 棰勪及鑺傜渷 |
|------|----------|
| 绉婚櫎 `@ibm/plex` | ~30MB node_modules |
| 缁熶竴鍥炬爣搴撳埌 lucide | ~500KB+ bundle |
| 绉婚櫎 CodeMirror 鍏ㄥ | ~300KB bundle |
| 绉婚櫎 framer-motion | ~150KB bundle |
| Rust workspace 缁熶竴 | 鍑忓皯鐗堟湰婕傜Щ椋庨櫓 + 缂栬瘧浼樺寲 |

---

## 浜斻€佸姛鑳藉啑浣欏垎鏋?

### 5.1 涓ゅ Git 鎿嶄綔浣撶郴

| 浣撶郴 | 鏂囦欢 | 璋冪敤鏂?| 妯″紡 |
|------|------|--------|------|
| A -- Git 闈㈡澘 | `hooks/git/useGitActions.ts` | `GitPanel.tsx` | `useState` + `useCallback` |
| B -- 浠诲姟宸ュ叿鏍?| `hooks/useGitOperations.ts` 绛?| `GitOperations.tsx` | `useMutation` (TanStack Query) |

涓よ€呮搷浣滃眰闈笉鍚岋紙A 绠?staging锛孊 绠?remote/branch锛夛紝**闈炵湡姝ｉ噸澶?*锛屼絾**椋庢牸涓嶄竴鑷?*鏄棶棰樸€傚缓璁粺涓€涓?`useMutation` 妯″紡銆?

### 5.2 usePush 涓?useForcePush 楂樺害閲嶅

缁撴瀯鍑犱箮瀹屽叏鐩稿悓锛堣嚜瀹氫箟 Error 绫汇€乵utationFn銆乷nSuccess/onError锛夛紝寤鸿鍚堝苟涓?`usePushOperation(force: boolean)`銆?

### 5.3 閬楃暀浠ｇ爜

- `useConversationHistoryOld.ts` (751琛? -- 鏂囦欢鍚嶅惈 "Old" 浣嗕负鍞竴瀹炵幇锛岄€氳繃 index.ts 瀵煎嚭
- 琚?`EntriesContext.tsx`銆乣useTodos.ts` 绛変娇鐢?

### 5.4 鏈娇鐢ㄧ粍浠讹紙宸插垹闄わ紝寮曠敤宸叉竻鐞嗭級

`DevBanner.tsx`銆乣ExecutorConfigForm.tsx`銆乣NewDesignLayout.tsx`銆乣useGitHubStars.ts` 绛夋墍鏈夊凡鍒犻櫎鏂囦欢鐨勫紩鐢ㄥ潎宸叉纭竻鐞嗐€?

---

## 鍏€佸姛鑳藉畬鏁村害 (TODO/FIXME/HACK)

### 6.1 鍓嶇 TODO (12 澶?

| 浼樺厛绾?| 鏂囦欢 | 琛屽彿 | 鍐呭 |
|--------|------|------|------|
| 楂?| `lib/api.ts` | 391, 396 | `link_workspace` / `unlink_workspace` 鏈疄鐜?|
| 楂?| `lib/api.ts` | 1207-1246 | 鍥剧墖涓婁紶鍔熻兘锛? 澶勶級锛孴auri 涓?FormData 涓嶅彲鐢?|
| 楂?| `lib/api.ts` | 1265 | Scratch 鍛戒护鏈疄鐜?|
| 涓?| `settings/AgentCard.tsx` | 328 | `// TODO: toast error` |
| 涓?| `panels/DockviewLogsPanel.tsx` | 22 | 闆嗘垚 VirtualizedList |
| 浣?| `git/CommitGraph.tsx` | 78 | commit 涓撶敤 diff 闈㈡澘 |
| 浣?| `layout/BranchInfoHeader.tsx` | 185 | 鍐茬獊淇℃伅鍙戦€佸埌 AI chat |
| 浣?| `lib/utils.ts` | 5 | tailwind v4 鍚庨噸鏂板惎鐢?twMerge |

### 6.2 鍚庣 TODO/FIXME (4 澶?

| 浼樺厛绾?| 鏂囦欢 | 鍐呭 |
|--------|------|------|
| 涓?| `executors/claude.rs:710` | ToolResult 绫诲瀷绯荤粺鏀寔 |
| 涓?| `services/filesystem_watcher.rs:149` | FIXME: 鏇存棭鎹曡幏鏂囦欢绫诲瀷淇℃伅 |
| 涓?| `services/git_host/azure/mod.rs:254` | Azure DevOps list_open_prs 鏈疄鐜?|
| 浣?| `services/config/versions/v4.rs:8` | DEPRECATED 鏃х増閰嶇疆 |

**娉ㄦ剰**: 鎵€鏈?TODO 鍧囨湭鍏宠仈宸ュ崟鍙枫€?
